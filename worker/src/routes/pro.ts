import { Hono } from 'hono';
import {
  createPublicClient,
  http,
  formatEther,
  type Hex,
} from 'viem';
import { Env } from '../types';
import { authMiddleware } from '../auth';

export const proRoutes = new Hono<{ Bindings: Env }>();

proRoutes.use('/*', authMiddleware());

// Pro 價格：1 MON 一次性終身買斷
const PRO_PRICE_WEI = 1_000_000_000_000_000_000n; // 1 MON
const PRO_PRICE_MON = '1';

// Monad chain 定義
const monadChain = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

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
      price_mon: PRO_PRICE_MON,
      price_wei: PRO_PRICE_WEI.toString(),
      description: 'One-time lifetime purchase. Removes NadMail signature from emails, adds gold badge.',
      method: 'POST /api/pro/buy',
      body: '{ "tx_hash": "0x..." }',
      deposit_address: c.env.WALLET_ADDRESS || 'Contact admin',
      chain: 'Monad (chainId: 143)',
    },
  });
});

/**
 * POST /api/pro/buy
 * Purchase Pro with MON payment (on-chain verification)
 *
 * Body: { tx_hash: string }
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

  const { tx_hash } = await c.req.json<{ tx_hash: string }>();

  if (!tx_hash || !tx_hash.startsWith('0x')) {
    return c.json({ error: 'Invalid transaction hash' }, 400);
  }

  // Check if tx already used
  const used = await c.env.DB.prepare(
    'SELECT id FROM credit_transactions WHERE tx_hash = ?'
  ).bind(tx_hash).first();

  if (used) {
    return c.json({ error: 'Transaction already used' }, 409);
  }

  // Verify on Monad chain
  const client = createPublicClient({
    chain: monadChain,
    transport: http(c.env.MONAD_RPC_URL),
  });

  let tx;
  let receipt;

  try {
    receipt = await client.waitForTransactionReceipt({
      hash: tx_hash as Hex,
      timeout: 15_000,
    });
    tx = await client.getTransaction({ hash: tx_hash as Hex });
  } catch {
    return c.json({ error: 'Transaction not found on Monad. Please wait and try again.' }, 404);
  }

  if (!tx || !receipt) {
    return c.json({ error: 'Transaction not found on Monad.' }, 404);
  }

  if (receipt.status !== 'success') {
    return c.json({ error: 'Transaction failed on-chain' }, 400);
  }

  const walletAddress = c.env.WALLET_ADDRESS?.toLowerCase();
  if (!walletAddress || tx.to?.toLowerCase() !== walletAddress) {
    return c.json({
      error: 'Transaction recipient is not the NadMail deposit address',
      expected: walletAddress,
    }, 400);
  }

  if (tx.value < PRO_PRICE_WEI) {
    return c.json({
      error: `Pro requires ${PRO_PRICE_MON} MON. You sent ${formatEther(tx.value)} MON.`,
      required: PRO_PRICE_MON,
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
    bonusCredits = Number((overpayment * 7n) / BigInt(1e18));
    if (bonusCredits > 0) {
      await c.env.DB.prepare(
        'UPDATE accounts SET credits = credits + ? WHERE handle = ?'
      ).bind(bonusCredits, auth.handle).run();
    }
  }

  return c.json({
    success: true,
    tier: 'pro',
    email: `${auth.handle}@${c.env.DOMAIN}`,
    mon_spent: formatEther(tx.value),
    chain: 'Monad',
    bonus_credits: bonusCredits,
    benefits: ['No email signature', 'Gold badge', 'Priority support'],
  });
});
