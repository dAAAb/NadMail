import { Hono } from 'hono';
import { Env } from '../types';
import { getTokenPrice } from '../nadfun';

export const identityRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/identity/:handle
 * 查詢 NadMail 用戶身份（公開，不需驗證）
 */
identityRoutes.get('/:handle', async (c) => {
  const handle = c.req.param('handle');

  const account = await c.env.DB.prepare(
    'SELECT handle, wallet, token_address, token_symbol, nad_name, created_at FROM accounts WHERE handle = ?'
  ).bind(handle).first<{
    handle: string;
    wallet: string;
    token_address: string | null;
    token_symbol: string | null;
    nad_name: string | null;
    created_at: number;
  }>();

  if (!account) {
    return c.json({ error: 'Handle not found' }, 404);
  }

  // Fetch token price if token exists
  let tokenPriceMon: string | null = null;
  let graduated = false;
  if (account.token_address) {
    try {
      const priceInfo = await getTokenPrice(account.token_address, c.env);
      tokenPriceMon = priceInfo.priceInMon;
      graduated = priceInfo.graduated;
    } catch {
      // Price lookup failed — not critical
    }
  }

  return c.json({
    handle: account.handle,
    email: `${account.handle}@${c.env.DOMAIN}`,
    wallet: account.wallet,
    token_address: account.token_address,
    token_symbol: account.token_symbol,
    token_price_mon: tokenPriceMon,
    graduated,
    nad_name: account.nad_name,
    registered_at: account.created_at,
  });
});

/**
 * GET /api/identity/wallet/:address
 * 用錢包地址反查 handle（公開）
 */
identityRoutes.get('/wallet/:address', async (c) => {
  const address = c.req.param('address').toLowerCase();

  const account = await c.env.DB.prepare(
    'SELECT handle, wallet, token_address, token_symbol, nad_name FROM accounts WHERE wallet = ?'
  ).bind(address).first<{
    handle: string;
    wallet: string;
    token_address: string | null;
    token_symbol: string | null;
    nad_name: string | null;
  }>();

  if (!account) {
    return c.json({ error: 'No email registered for this wallet' }, 404);
  }

  return c.json({
    handle: account.handle,
    email: `${account.handle}@${c.env.DOMAIN}`,
    wallet: account.wallet,
    token_address: account.token_address,
    token_symbol: account.token_symbol,
    nad_name: account.nad_name,
  });
});

/**
 * GET /api/identity
 * 統計資訊（公開）
 */
identityRoutes.get('/', async (c) => {
  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM accounts'
  ).first<{ total: number }>();

  const emailCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails'
  ).first<{ total: number }>();

  return c.json({
    total_agents: countResult?.total || 0,
    total_emails: emailCountResult?.total || 0,
  });
});
