import { Hono } from 'hono';
import {
  createPublicClient,
  http,
  formatEther,
  type Hex,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { Env } from '../types';
import { authMiddleware, createToken } from '../auth';

export const proRoutes = new Hono<{ Bindings: Env }>();

proRoutes.use('/*', authMiddleware());

// Pro 價格：0.008 ETH 一次性終身買斷
const PRO_PRICE_WEI = 8_000_000_000_000_000n; // 0.008 ETH
const PRO_PRICE_ETH = '0.008';

const BASE_RPC = 'https://base.publicnode.com';
const ETH_MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

/**
 * GET /api/pro/status
 * Check Pro status and pricing
 */
proRoutes.get('/status', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered' }, 403);
  }

  const account = await c.env.DB.prepare(
    'SELECT tier FROM accounts WHERE handle = ?'
  ).bind(auth.handle).first<{ tier: string }>();

  const isPro = account?.tier === 'pro';

  return c.json({
    handle: auth.handle,
    tier: account?.tier || 'free',
    is_pro: isPro,
    benefits: isPro
      ? ['No email signature', 'Gold badge', 'Priority support']
      : [],
    upgrade: isPro ? null : {
      price_eth: PRO_PRICE_ETH,
      price_wei: PRO_PRICE_WEI.toString(),
      description: 'One-time lifetime purchase. Removes BaseMail signature from emails, adds gold badge.',
      method: 'POST /api/pro/buy',
      body: '{ "tx_hash": "0x..." }',
      deposit_address: c.env.WALLET_ADDRESS || 'Contact admin',
    },
  });
});

/**
 * POST /api/pro/buy
 * Purchase Pro with ETH payment (on-chain verification)
 *
 * Body: { tx_hash: string, chain_id?: number }
 */
proRoutes.post('/buy', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered' }, 403);
  }

  // Check if already Pro
  const account = await c.env.DB.prepare(
    'SELECT tier FROM accounts WHERE handle = ?'
  ).bind(auth.handle).first<{ tier: string }>();

  if (account?.tier === 'pro') {
    return c.json({ error: 'Already a Pro member', tier: 'pro' }, 400);
  }

  const { tx_hash, chain_id } = await c.req.json<{ tx_hash: string; chain_id?: number }>();

  if (!tx_hash || !tx_hash.startsWith('0x')) {
    return c.json({ error: 'Invalid transaction hash' }, 400);
  }

  // Check if tx already used (in credit_transactions or pro purchases)
  const used = await c.env.DB.prepare(
    'SELECT id FROM credit_transactions WHERE tx_hash = ?'
  ).bind(tx_hash).first();

  if (used) {
    return c.json({ error: 'Transaction already used' }, 409);
  }

  // Auto-detect chain
  const chainsToTry: Array<{ chain: typeof base; rpc: string; id: number }> = chain_id === 1
    ? [{ chain: mainnet, rpc: ETH_MAINNET_RPC, id: 1 }, { chain: base, rpc: BASE_RPC, id: 8453 }]
    : [{ chain: base, rpc: BASE_RPC, id: 8453 }, { chain: mainnet, rpc: ETH_MAINNET_RPC, id: 1 }];

  let tx;
  let receipt;
  let foundChainId = 0;

  for (const attempt of chainsToTry) {
    try {
      const client = createPublicClient({ chain: attempt.chain, transport: http(attempt.rpc) });
      receipt = await client.waitForTransactionReceipt({
        hash: tx_hash as Hex,
        timeout: 15_000,
      });
      tx = await client.getTransaction({ hash: tx_hash as Hex });
      foundChainId = attempt.id;
      break;
    } catch {
      // Try next chain
    }
  }

  if (!tx || !receipt) {
    return c.json({ error: 'Transaction not found on Base or ETH Mainnet. Please wait and try again.' }, 404);
  }

  if (receipt.status !== 'success') {
    return c.json({ error: 'Transaction failed on-chain' }, 400);
  }

  const walletAddress = c.env.WALLET_ADDRESS?.toLowerCase();
  if (!walletAddress || tx.to?.toLowerCase() !== walletAddress) {
    return c.json({
      error: 'Transaction recipient is not the BaseMail deposit address',
      expected: walletAddress,
    }, 400);
  }

  if (tx.value < PRO_PRICE_WEI) {
    return c.json({
      error: `Pro requires ${PRO_PRICE_ETH} ETH. You sent ${formatEther(tx.value)} ETH.`,
      required: PRO_PRICE_ETH,
      sent: formatEther(tx.value),
    }, 400);
  }

  // Record transaction
  const txId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(
    `INSERT INTO credit_transactions (id, handle, type, amount, tx_hash, price_wei, created_at)
     VALUES (?, ?, 'pro_purchase', 0, ?, ?, ?)`
  ).bind(
    txId,
    auth.handle,
    tx_hash,
    tx.value.toString(),
    Math.floor(Date.now() / 1000),
  ).run();

  // Upgrade to Pro
  await c.env.DB.prepare(
    'UPDATE accounts SET tier = ? WHERE handle = ?'
  ).bind('pro', auth.handle).run();

  // Overpayment → give credits for the difference
  let bonusCredits = 0;
  const overpayment = tx.value - PRO_PRICE_WEI;
  if (overpayment > 0n) {
    bonusCredits = Number((overpayment * 1_000_000n) / BigInt(1e18));
    if (bonusCredits > 0) {
      await c.env.DB.prepare(
        'UPDATE accounts SET credits = credits + ? WHERE handle = ?'
      ).bind(bonusCredits, auth.handle).run();
    }
  }

  return c.json({
    success: true,
    tier: 'pro',
    email: `${auth.handle}@basemail.ai`,
    eth_spent: formatEther(tx.value),
    chain: foundChainId === 1 ? 'ETH Mainnet' : 'Base',
    bonus_credits: bonusCredits,
    benefits: ['No email signature', 'Gold badge', 'Priority support'],
  });
});
