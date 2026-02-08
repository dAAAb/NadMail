import { Hono } from 'hono';
import {
  createPublicClient,
  http,
  formatEther,
  type Hex,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { Env } from '../types';
import { authMiddleware } from '../auth';

export const creditsRoutes = new Hono<{ Bindings: Env }>();

creditsRoutes.use('/*', authMiddleware());

// 1 credit = 1 封外部 email
// 定價：1000 credits = 0.001 ETH（~$2.70）
const CREDITS_PER_ETH = 1_000_000; // 1 ETH = 1,000,000 credits
const MIN_PURCHASE_WEI = 100_000_000_000_000n; // 0.0001 ETH = 100 credits 最低購買量

const BASE_RPC = 'https://base.publicnode.com';
const ETH_MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

/**
 * GET /api/credits
 * 查詢餘額和定價資訊
 */
creditsRoutes.get('/', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered' }, 403);
  }

  const account = await c.env.DB.prepare(
    'SELECT credits FROM accounts WHERE handle = ?'
  ).bind(auth.handle).first<{ credits: number }>();

  return c.json({
    handle: auth.handle,
    credits: account?.credits || 0,
    pricing: {
      credits_per_eth: CREDITS_PER_ETH,
      cost_per_email_usd: '$0.002',
      example: '0.001 ETH = 1,000 email credits',
      min_purchase: '0.0001 ETH = 100 credits',
      deposit_address: c.env.WALLET_ADDRESS || 'Contact admin',
    },
  });
});

/**
 * POST /api/credits/buy
 * 用 Base 鏈上的 ETH 轉帳購買 credits
 *
 * Body: { tx_hash: string }
 *
 * 流程：
 * 1. 驗證交易存在且已確認
 * 2. 確認收款地址是 Worker 錢包
 * 3. 確認該交易未被使用過
 * 4. 根據金額計算 credits
 * 5. 更新帳號餘額
 */
creditsRoutes.post('/buy', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered' }, 403);
  }

  const { tx_hash, chain_id } = await c.req.json<{ tx_hash: string; chain_id?: number }>();

  if (!tx_hash || !tx_hash.startsWith('0x')) {
    return c.json({ error: 'Invalid transaction hash' }, 400);
  }

  // 檢查交易是否已使用過
  const used = await c.env.DB.prepare(
    'SELECT id FROM credit_transactions WHERE tx_hash = ?'
  ).bind(tx_hash).first();

  if (used) {
    return c.json({ error: 'Transaction already used' }, 409);
  }

  // 自動偵測交易在哪條鏈上（先嘗試指定鏈，再嘗試另一條）
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
    return c.json({ error: 'Transaction not found on Base or ETH Mainnet. Please wait a moment and try again.' }, 404);
  }

  // 確認交易成功
  if (receipt.status !== 'success') {
    return c.json({ error: 'Transaction failed on-chain' }, 400);
  }

  // 確認收款地址是 Worker 錢包
  const walletAddress = c.env.WALLET_ADDRESS?.toLowerCase();
  if (!walletAddress || tx.to?.toLowerCase() !== walletAddress) {
    return c.json({
      error: 'Transaction recipient is not the BaseMail deposit address',
      expected: walletAddress,
    }, 400);
  }

  // 確認金額
  if (tx.value < MIN_PURCHASE_WEI) {
    return c.json({
      error: `Minimum purchase is 0.0001 ETH (100 credits)`,
      sent: formatEther(tx.value),
    }, 400);
  }

  // 計算 credits（1 ETH = 1,000,000 credits）
  const credits = Number((tx.value * BigInt(CREDITS_PER_ETH)) / BigInt(1e18));

  // 記錄交易
  const txId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(
    `INSERT INTO credit_transactions (id, handle, type, amount, tx_hash, price_wei, created_at)
     VALUES (?, ?, 'purchase', ?, ?, ?, ?)`
  ).bind(
    txId,
    auth.handle,
    credits,
    tx_hash,
    tx.value.toString(),
    Math.floor(Date.now() / 1000),
  ).run();

  // 更新帳號餘額
  await c.env.DB.prepare(
    'UPDATE accounts SET credits = credits + ? WHERE handle = ?'
  ).bind(credits, auth.handle).run();

  const newBalance = await c.env.DB.prepare(
    'SELECT credits FROM accounts WHERE handle = ?'
  ).bind(auth.handle).first<{ credits: number }>();

  return c.json({
    success: true,
    purchased: credits,
    eth_spent: formatEther(tx.value),
    balance: newBalance?.credits || credits,
    tx_hash,
    chain: foundChainId === 1 ? 'ETH Mainnet' : 'Base',
  });
});

/**
 * GET /api/credits/history
 * 查詢 credit 交易紀錄
 */
creditsRoutes.get('/history', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered' }, 403);
  }

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM credit_transactions WHERE handle = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(auth.handle).all();

  return c.json({ transactions: results });
});
