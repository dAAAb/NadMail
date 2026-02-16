import { Hono } from 'hono';
import { Env } from '../types';

export const statsRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/stats
 * Public stats for landing page conversion.
 * - agents: number of registered accounts
 * - email_events: total email rows (inbox + sent). Internal email counts twice (send+receive).
 * - sent: sent rows
 * - received: inbox rows
 */
statsRoutes.get('/', async (c) => {
  const agentsRow = await c.env.DB.prepare('SELECT COUNT(*) as count FROM accounts').first<{ count: number }>();
  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) as count FROM emails').first<{ count: number }>();
  const sentRow = await c.env.DB.prepare("SELECT COUNT(*) as count FROM emails WHERE folder = 'sent'").first<{ count: number }>();
  const inboxRow = await c.env.DB.prepare("SELECT COUNT(*) as count FROM emails WHERE folder = 'inbox'").first<{ count: number }>();

  return c.json({
    agents: agentsRow?.count || 0,
    email_events: totalRow?.count || 0,
    sent: sentRow?.count || 0,
    received: inboxRow?.count || 0,
  });
});

/**
 * GET /api/stats/tokens
 * Public — returns all NadMail accounts that have a meme coin.
 * Used by the dashboard sidebar to show token holdings.
 */
statsRoutes.get('/tokens', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT handle, token_address, token_symbol FROM accounts WHERE token_address IS NOT NULL ORDER BY created_at'
  ).all<{ handle: string; token_address: string; token_symbol: string }>();

  return c.json({
    tokens: (rows.results || []).map(r => ({
      handle: r.handle,
      address: r.token_address,
      symbol: r.token_symbol,
    })),
  });
});
