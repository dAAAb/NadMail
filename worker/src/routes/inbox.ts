import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware } from '../auth';

export const inboxRoutes = new Hono<{ Bindings: Env }>();

inboxRoutes.use('/*', authMiddleware());

/**
 * GET /api/inbox
 * List emails
 * Query: ?folder=inbox|sent&limit=20&offset=0
 */
inboxRoutes.get('/', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered for this wallet' }, 403);
  }

  const folder = c.req.query('folder') || 'inbox';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const emails = await c.env.DB.prepare(
    `SELECT id, folder, from_addr, to_addr, subject, snippet, size, read, created_at
     FROM emails
     WHERE handle = ? AND folder = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(auth.handle, folder, limit, offset).all();

  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails WHERE handle = ? AND folder = ?'
  ).bind(auth.handle, folder).first<{ total: number }>();

  const unreadResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as unread FROM emails WHERE handle = ? AND folder = ? AND read = 0'
  ).bind(auth.handle, folder).first<{ unread: number }>();

  return c.json({
    emails: emails.results,
    total: countResult?.total || 0,
    unread: unreadResult?.unread || 0,
    limit,
    offset,
  });
});

/**
 * GET /api/inbox/:id
 * Read a specific email with body and attachment metadata
 */
inboxRoutes.get('/:id', async (c) => {
  const auth = c.get('auth');
  const emailId = c.req.param('id');

  const email = await c.env.DB.prepare(
    'SELECT * FROM emails WHERE id = ? AND handle = ?'
  ).bind(emailId, auth.handle).first();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  // Mark as read
  if (!(email as { read: number }).read) {
    await c.env.DB.prepare(
      'UPDATE emails SET read = 1 WHERE id = ?'
    ).bind(emailId).run();
  }

  // Fetch raw content from R2
  const r2Key = (email as { r2_key: string }).r2_key;
  const r2Object = await c.env.EMAIL_STORE.get(r2Key);
  const body = r2Object ? await r2Object.text() : null;

  // Parse attachment metadata from MIME
  const attachments = body ? parseAttachmentMeta(body) : [];

  return c.json({
    ...email,
    read: 1,
    body,
    attachments,
  });
});

/**
 * GET /api/inbox/:id/attachment/:index
 * Download a specific attachment by index
 */
inboxRoutes.get('/:id/attachment/:index', async (c) => {
  const auth = c.get('auth');
  const emailId = c.req.param('id');
  const index = parseInt(c.req.param('index'));

  const email = await c.env.DB.prepare(
    'SELECT r2_key FROM emails WHERE id = ? AND handle = ?'
  ).bind(emailId, auth.handle).first<{ r2_key: string }>();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  const r2Object = await c.env.EMAIL_STORE.get(email.r2_key);
  if (!r2Object) {
    return c.json({ error: 'Email content not found' }, 404);
  }

  const raw = await r2Object.text();
  const attachments = extractAttachments(raw);

  if (index < 0 || index >= attachments.length) {
    return c.json({ error: 'Attachment not found' }, 404);
  }

  const att = attachments[index];
  const data = Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0));

  return new Response(data, {
    headers: {
      'Content-Type': att.content_type,
      'Content-Disposition': `attachment; filename="${att.filename}"`,
    },
  });
});

/**
 * GET /api/inbox/:id/raw
 * Get raw email content
 */
inboxRoutes.get('/:id/raw', async (c) => {
  const auth = c.get('auth');
  const emailId = c.req.param('id');

  const email = await c.env.DB.prepare(
    'SELECT r2_key FROM emails WHERE id = ? AND handle = ?'
  ).bind(emailId, auth.handle).first<{ r2_key: string }>();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  const r2Object = await c.env.EMAIL_STORE.get(email.r2_key);
  if (!r2Object) {
    return c.json({ error: 'Email content not found' }, 404);
  }

  return new Response(r2Object.body, {
    headers: { 'Content-Type': 'message/rfc822' },
  });
});

/**
 * DELETE /api/inbox/:id
 * Delete an email
 */
inboxRoutes.delete('/:id', async (c) => {
  const auth = c.get('auth');
  const emailId = c.req.param('id');

  const email = await c.env.DB.prepare(
    'SELECT r2_key FROM emails WHERE id = ? AND handle = ?'
  ).bind(emailId, auth.handle).first<{ r2_key: string }>();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  await c.env.EMAIL_STORE.delete(email.r2_key);
  await c.env.DB.prepare(
    'DELETE FROM emails WHERE id = ?'
  ).bind(emailId).run();

  return c.json({ success: true });
});

// ── MIME Parsing Helpers ──

interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
}

interface AttachmentFull extends AttachmentMeta {
  data: string; // base64
}

function parseAttachmentMeta(raw: string): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/);
  if (!boundaryMatch) return attachments;

  const boundary = boundaryMatch[1];
  const parts = raw.split('--' + boundary);

  for (const part of parts) {
    const dispositionMatch = part.match(/Content-Disposition:\s*attachment[^]*?filename="?([^"\r\n]+)"?/i);
    if (!dispositionMatch) continue;

    const filename = dispositionMatch[1].trim();
    const ctMatch = part.match(/Content-Type:\s*([^\r\n;]+)/i);
    const contentType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

    // Estimate size from base64 data
    const bodyStart = part.indexOf('\r\n\r\n') !== -1
      ? part.indexOf('\r\n\r\n') + 4
      : part.indexOf('\n\n') !== -1
        ? part.indexOf('\n\n') + 2
        : -1;

    let size = 0;
    if (bodyStart !== -1) {
      const b64 = part.slice(bodyStart).replace(/[\r\n\s]/g, '');
      size = Math.floor(b64.length * 0.75);
    }

    attachments.push({ filename, content_type: contentType, size });
  }

  return attachments;
}

function extractAttachments(raw: string): AttachmentFull[] {
  const attachments: AttachmentFull[] = [];
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/);
  if (!boundaryMatch) return attachments;

  const boundary = boundaryMatch[1];
  const parts = raw.split('--' + boundary);

  for (const part of parts) {
    const dispositionMatch = part.match(/Content-Disposition:\s*attachment[^]*?filename="?([^"\r\n]+)"?/i);
    if (!dispositionMatch) continue;

    const filename = dispositionMatch[1].trim();
    const ctMatch = part.match(/Content-Type:\s*([^\r\n;]+)/i);
    const contentType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

    const bodyStart = part.indexOf('\r\n\r\n') !== -1
      ? part.indexOf('\r\n\r\n') + 4
      : part.indexOf('\n\n') !== -1
        ? part.indexOf('\n\n') + 2
        : -1;

    if (bodyStart === -1) continue;

    const data = part.slice(bodyStart).replace(/[\r\n\s]/g, '').replace(/--$/, '');
    const size = Math.floor(data.length * 0.75);

    attachments.push({ filename, content_type: contentType, size, data });
  }

  return attachments;
}
