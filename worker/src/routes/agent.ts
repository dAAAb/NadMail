import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware } from '../auth';

export const agentRoutes = new Hono<{ Bindings: Env }>();

agentRoutes.use('/*', authMiddleware());

/**
 * GET /api/agent/logs
 * 查詢 $DIPLOMAT agent 活動紀錄
 * Query: ?limit=20&offset=0
 */
agentRoutes.get('/logs', async (c) => {
  const auth = c.get('auth');

  // Only diplomat or admin can view logs
  if (auth.handle !== 'diplomat' && auth.handle !== 'nadmail') {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
  const offset = Number(c.req.query('offset')) || 0;

  const [logsResult, countResult, statsResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, started_at, finished_at, duration_ms, status,
              emails_processed, emails_replied, posts_created, comments_left,
              error_message
       FROM agent_logs ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all(),

    c.env.DB.prepare('SELECT COUNT(*) as total FROM agent_logs').first<{ total: number }>(),

    c.env.DB.prepare(
      `SELECT
         COUNT(*) as total_cycles,
         SUM(emails_replied) as total_emails,
         SUM(posts_created) as total_posts,
         SUM(comments_left) as total_comments,
         AVG(duration_ms) as avg_duration_ms,
         MAX(started_at) as last_run
       FROM agent_logs`
    ).first<{
      total_cycles: number;
      total_emails: number;
      total_posts: number;
      total_comments: number;
      avg_duration_ms: number;
      last_run: number;
    }>(),
  ]);

  return c.json({
    logs: logsResult.results || [],
    total: countResult?.total || 0,
    stats: {
      total_cycles: statsResult?.total_cycles || 0,
      total_emails: statsResult?.total_emails || 0,
      total_posts: statsResult?.total_posts || 0,
      total_comments: statsResult?.total_comments || 0,
      avg_duration_ms: Math.round(statsResult?.avg_duration_ms || 0),
      last_run: statsResult?.last_run || null,
    },
  });
});

/**
 * GET /api/agent/logs/:id
 * 查詢單筆 log 詳情（含 details JSON）
 */
agentRoutes.get('/logs/:id', async (c) => {
  const auth = c.get('auth');

  if (auth.handle !== 'diplomat' && auth.handle !== 'nadmail') {
    return c.json({ error: 'Unauthorized' }, 403);
  }

  const logId = c.req.param('id');
  const log = await c.env.DB.prepare(
    'SELECT * FROM agent_logs WHERE id = ?'
  ).bind(logId).first();

  if (!log) {
    return c.json({ error: 'Log not found' }, 404);
  }

  // Parse details JSON
  let details = [];
  try {
    details = JSON.parse((log.details as string) || '[]');
  } catch {}

  return c.json({ ...log, details });
});
