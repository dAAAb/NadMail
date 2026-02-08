import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware } from '../auth';

export const waitlistRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/waitlist
 * 加入 Basename 自動註冊等候名單（Coming Soon 功能）
 *
 * Body: { desired_handle: string, wallet: string }
 */
waitlistRoutes.post('/', async (c) => {
  const { desired_handle, wallet } = await c.req.json<{
    desired_handle: string;
    wallet: string;
  }>();

  if (!desired_handle || !wallet) {
    return c.json({ error: 'desired_handle and wallet are required' }, 400);
  }

  if (!isValidHandle(desired_handle)) {
    return c.json({ error: 'Invalid handle format' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO waitlist (id, wallet, desired_handle, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(id, wallet.toLowerCase(), desired_handle, Math.floor(Date.now() / 1000)).run();

  return c.json({
    success: true,
    message: 'Added to Basename auto-register waitlist',
    desired_email: `${desired_handle}@basemail.ai`,
  });
});

/**
 * GET /api/waitlist/stats
 * 等候名單統計（公開）
 */
waitlistRoutes.get('/stats', async (c) => {
  const totalResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM waitlist'
  ).first<{ total: number }>();

  const uniqueHandlesResult = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT desired_handle) as unique_handles FROM waitlist'
  ).first<{ unique_handles: number }>();

  return c.json({
    total_signups: totalResult?.total || 0,
    unique_handles_requested: uniqueHandlesResult?.unique_handles || 0,
  });
});

function isValidHandle(handle: string): boolean {
  if (handle.length < 3 || handle.length > 32) return false;
  return /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(handle);
}
