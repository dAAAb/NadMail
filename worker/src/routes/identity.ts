import { Hono } from 'hono';
import { Env } from '../types';

export const identityRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/identity/:handle
 * 查詢 BaseMail 用戶身份（公開，不需驗證）
 */
identityRoutes.get('/:handle', async (c) => {
  const handle = c.req.param('handle');

  const account = await c.env.DB.prepare(
    'SELECT handle, wallet, basename, created_at, tx_hash FROM accounts WHERE handle = ?'
  ).bind(handle).first();

  if (!account) {
    return c.json({ error: 'Handle not found' }, 404);
  }

  return c.json({
    handle: (account as any).handle,
    email: `${(account as any).handle}@${c.env.DOMAIN}`,
    wallet: (account as any).wallet,
    basename: (account as any).basename,
    registered_at: (account as any).created_at,
    tx_hash: (account as any).tx_hash,
  });
});

/**
 * GET /api/identity/wallet/:address
 * 用錢包地址反查 handle（公開）
 */
identityRoutes.get('/wallet/:address', async (c) => {
  const address = c.req.param('address').toLowerCase();

  const account = await c.env.DB.prepare(
    'SELECT handle, wallet, basename, created_at FROM accounts WHERE wallet = ?'
  ).bind(address).first();

  if (!account) {
    return c.json({ error: 'No email registered for this wallet' }, 404);
  }

  return c.json({
    handle: (account as any).handle,
    email: `${(account as any).handle}@${c.env.DOMAIN}`,
    wallet: (account as any).wallet,
    basename: (account as any).basename,
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
