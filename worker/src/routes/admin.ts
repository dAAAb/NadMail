import { Hono } from 'hono';
import { Env } from '../types';
import { sendInternalEmail } from '../send-internal';

export const adminRoutes = new Hono<{ Bindings: Env }>();

const ADMIN_HANDLES = ['diplomat', 'nadmail'];
const ADMIN_DAILY_LIMIT = 100;

/**
 * Admin auth middleware — verifies ADMIN_SECRET
 */
function adminAuth() {
  return async (c: any, next: any) => {
    const secret = c.env.ADMIN_SECRET;
    if (!secret) {
      return c.json({ error: 'Admin API not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== secret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}

/**
 * POST /api/admin/send
 * Send email as an admin account (diplomat or nadmail).
 * Auth: Bearer ADMIN_SECRET
 *
 * Body: { from_handle, to, subject, body, emo_amount? }
 */
adminRoutes.post('/send', adminAuth(), async (c) => {
  const body = await c.req.json<{
    from_handle: string;
    to: string;
    subject: string;
    body: string;
    emo_amount?: number;
  }>().catch(() => null);

  if (!body || !body.from_handle || !body.to || !body.subject || !body.body) {
    return c.json({ error: 'from_handle, to, subject, and body are required' }, 400);
  }

  const fromHandle = body.from_handle.toLowerCase();

  if (!ADMIN_HANDLES.includes(fromHandle)) {
    return c.json({
      error: `from_handle must be one of: ${ADMIN_HANDLES.join(', ')}`,
    }, 403);
  }

  // Look up sender account
  const sender = await c.env.DB.prepare(
    'SELECT handle, wallet FROM accounts WHERE handle = ?'
  ).bind(fromHandle).first<{ handle: string; wallet: string }>();

  if (!sender) {
    return c.json({ error: `Account not found: ${fromHandle}` }, 404);
  }

  // Admin rate limit (100/day)
  const today = new Date().toISOString().split('T')[0];
  const dailyCount = await c.env.DB.prepare(
    'SELECT count FROM daily_email_counts WHERE handle = ? AND date = ?'
  ).bind(`admin:${fromHandle}`, today).first<{ count: number }>();

  if (dailyCount && dailyCount.count >= ADMIN_DAILY_LIMIT) {
    return c.json({
      error: `Admin daily limit reached (${ADMIN_DAILY_LIMIT}/day)`,
      limit: ADMIN_DAILY_LIMIT,
      used: dailyCount.count,
    }, 429);
  }

  // Track admin sends separately
  await c.env.DB.prepare(
    `INSERT INTO daily_email_counts (handle, date, count) VALUES (?, ?, 1)
     ON CONFLICT(handle, date) DO UPDATE SET count = count + 1`
  ).bind(`admin:${fromHandle}`, today).run();

  // Send
  const isInternal = body.to.toLowerCase().endsWith(`@${c.env.DOMAIN}`);

  if (!isInternal) {
    return c.json({ error: 'Admin send only supports internal @nadmail.ai recipients' }, 400);
  }

  try {
    const result = await sendInternalEmail(c.env, {
      fromHandle: sender.handle,
      fromWallet: sender.wallet,
      to: body.to,
      subject: body.subject,
      body: body.body,
      emo_amount: body.emo_amount,
    });

    console.log(`[admin] ${fromHandle} → ${body.to}: ${result.email_id}`);

    const response: Record<string, unknown> = {
      success: true,
      email_id: result.email_id,
      from: `${sender.handle}@${c.env.DOMAIN}`,
      to: body.to,
      subject: body.subject,
    };

    if (result.microbuy) {
      response.microbuy = {
        tx: result.microbuy.tx,
        amount: `${result.microbuy.totalMonSpent} MON`,
        tokens_received: `$${result.microbuy.tokenSymbol}`,
        tokens_bought: result.microbuy.tokensBought,
      };
    }

    return c.json(response);
  } catch (e: any) {
    console.log(`[admin] Send failed: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }
});
