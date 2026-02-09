import { Hono } from 'hono';
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';
import { Env } from '../types';
import { authMiddleware } from '../auth';
import { microBuyWithPrice, parseEther, type MicroBuyResult } from '../nadfun';
import {
  buildTextSignature,
  buildHtmlSignature,
  buildTextSignatureWithPrice,
  buildHtmlSignatureWithPrice,
} from '../signature';

export const sendRoutes = new Hono<{ Bindings: Env }>();

sendRoutes.use('/*', authMiddleware());

const DAILY_EMAIL_LIMIT = 10;
const EMO_BUY_MAX = 0.1;           // Max emo-buy per transaction (MON)
const EMO_BUY_DAILY_LIMIT = 0.5;   // Max total emo-buy per user per day (MON)
const BASE_MICRO_BUY = parseEther('0.001');

interface Attachment {
  filename: string;
  content_type: string;
  data: string; // base64 encoded
}

/**
 * POST /api/send
 * Send email + trigger micro-buy for internal emails
 *
 * Flow (internal): validate → micro-buy → build MIME with price sig → store
 * Flow (external): validate → build MIME with static sig → send via Resend → store
 */
sendRoutes.post('/', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered for this wallet' }, 403);
  }

  let parsed: { to: string; subject: string; body: string; html?: string; in_reply_to?: string; attachments?: Attachment[]; emo_amount?: number };
  try {
    parsed = await c.req.json();
  } catch (e: any) {
    return c.json({
      error: 'Invalid JSON in request body',
      hint: 'Ensure special characters in body/subject are properly escaped (e.g. use \\n for newlines, not raw control chars)',
      detail: e.message,
    }, 400);
  }
  const { to, subject, body, html, in_reply_to, attachments, emo_amount } = parsed;

  // Validate emo_amount
  const emoAmount = typeof emo_amount === 'number' ? Math.min(Math.max(emo_amount, 0), EMO_BUY_MAX) : 0;

  if (!to || !subject || !body) {
    return c.json({ error: 'to, subject, and body are required' }, 400);
  }

  if (!isValidEmail(to)) {
    return c.json({ error: 'Invalid recipient email address' }, 400);
  }

  // Validate attachments (max 10MB total)
  if (attachments && attachments.length > 0) {
    const totalSize = attachments.reduce((sum, a) => sum + (a.data?.length || 0) * 0.75, 0);
    if (totalSize > 10 * 1024 * 1024) {
      return c.json({ error: 'Total attachment size exceeds 10MB limit' }, 400);
    }
    for (const att of attachments) {
      if (!att.filename || !att.content_type || !att.data) {
        return c.json({ error: 'Each attachment must have filename, content_type, and data (base64)' }, 400);
      }
    }
  }

  const fromAddr = `${auth.handle}@${c.env.DOMAIN}`;
  const emailId = generateId();
  const now = Math.floor(Date.now() / 1000);

  // Check tier for signature
  const acctTier = await c.env.DB.prepare(
    'SELECT tier FROM accounts WHERE handle = ?'
  ).bind(auth.handle).first<{ tier: string }>();
  const isPro = acctTier?.tier === 'pro';

  const isInternal = to.toLowerCase().endsWith(`@${c.env.DOMAIN}`);

  let microbuyResult: MicroBuyResult | null = null;

  if (isInternal) {
    // ── Internal delivery ──
    let recipientHandle = to.split('@')[0].toLowerCase();

    let recipient = await c.env.DB.prepare(
      'SELECT handle, token_address, token_symbol FROM accounts WHERE handle = ?'
    ).bind(recipientHandle).first<{ handle: string; token_address: string | null; token_symbol: string | null }>();

    // 0x 地址 fallback
    if (!recipient && /^0x[a-f0-9]{40}$/.test(recipientHandle)) {
      recipient = await c.env.DB.prepare(
        'SELECT handle, token_address, token_symbol FROM accounts WHERE wallet = ?'
      ).bind(recipientHandle).first<{ handle: string; token_address: string | null; token_symbol: string | null }>();
      if (recipient) {
        recipientHandle = recipient.handle;
      }
    }

    // previous_handle fallback (for upgraded accounts)
    if (!recipient) {
      recipient = await c.env.DB.prepare(
        'SELECT handle, token_address, token_symbol FROM accounts WHERE previous_handle = ?'
      ).bind(recipientHandle).first<{ handle: string; token_address: string | null; token_symbol: string | null }>();
      if (recipient) {
        recipientHandle = recipient.handle;
      }
    }

    if (!recipient) {
      return c.json({ error: `Recipient not found: ${to}` }, 404);
    }

    // Check daily email limit
    const today = new Date().toISOString().split('T')[0];
    const dailyCount = await c.env.DB.prepare(
      'SELECT count FROM daily_email_counts WHERE handle = ? AND date = ?'
    ).bind(auth.handle, today).first<{ count: number }>();

    if (dailyCount && dailyCount.count >= DAILY_EMAIL_LIMIT) {
      return c.json({
        error: `Daily email limit reached (${DAILY_EMAIL_LIMIT}/day)`,
        limit: DAILY_EMAIL_LIMIT,
        used: dailyCount.count,
        resets: 'midnight UTC',
      }, 429);
    }

    // ── Check emo-buy daily limit ──
    let effectiveEmo = emoAmount;
    if (effectiveEmo > 0) {
      const emoDaily = await c.env.DB.prepare(
        'SELECT total_mon FROM daily_emobuy_totals WHERE handle = ? AND date = ?'
      ).bind(auth.handle, today).first<{ total_mon: number }>();
      const spent = emoDaily?.total_mon || 0;
      if (spent + effectiveEmo > EMO_BUY_DAILY_LIMIT) {
        const remaining = Math.max(0, EMO_BUY_DAILY_LIMIT - spent);
        if (remaining < 0.001) {
          return c.json({
            error: 'Daily emo-buy limit reached',
            daily_limit: EMO_BUY_DAILY_LIMIT,
            spent,
            remaining: 0,
            resets: 'midnight UTC',
          }, 429);
        }
        effectiveEmo = Math.min(effectiveEmo, remaining);
      }
    }

    // ── Micro-buy FIRST (so we have price data for signature) ──
    const totalBuyAmount = effectiveEmo > 0
      ? BASE_MICRO_BUY + parseEther(effectiveEmo.toString())
      : undefined; // undefined = default 0.001

    if (recipient.token_address) {
      try {
        microbuyResult = await microBuyWithPrice(
          recipient.token_address,
          recipient.token_symbol || recipientHandle.toUpperCase(),
          auth.wallet,
          c.env,
          totalBuyAmount,
        );
      } catch (e: any) {
        console.log(`[send] Micro-buy failed: ${e.message}`);
      }
    }

    // ── Update emo-buy daily tracking ──
    if (effectiveEmo > 0 && microbuyResult) {
      await c.env.DB.prepare(
        `INSERT INTO daily_emobuy_totals (handle, date, total_mon, tx_count) VALUES (?, ?, ?, 1)
         ON CONFLICT(handle, date) DO UPDATE SET total_mon = total_mon + ?, tx_count = tx_count + 1`
      ).bind(auth.handle, today, effectiveEmo, effectiveEmo).run();
    }

    // ── Build MIME with dynamic signature ──
    const textSig = isPro ? '' : (microbuyResult ? buildTextSignatureWithPrice(microbuyResult, effectiveEmo) : buildTextSignature());
    const htmlSig = isPro ? '' : (microbuyResult ? buildHtmlSignatureWithPrice(microbuyResult, effectiveEmo) : buildHtmlSignature());

    const finalBody = body + textSig;
    const finalHtml = html ? html + htmlSig : undefined;

    const msg = buildMime(auth.handle, fromAddr, to, subject, finalBody, finalHtml, auth.wallet, in_reply_to, attachments, c.env);
    const rawMime = msg.asRaw();
    const snippet = body.slice(0, 200);

    // Reply headers
    if (in_reply_to) {
      const origEmail = await c.env.DB.prepare(
        'SELECT id FROM emails WHERE id = ? AND handle = ?'
      ).bind(in_reply_to, auth.handle).first<{ id: string }>();
      if (origEmail) {
        msg.setHeader('In-Reply-To', `<${origEmail.id}@${c.env.DOMAIN}>`);
        msg.setHeader('References', `<${origEmail.id}@${c.env.DOMAIN}>`);
      }
    }

    const rawMimeFinal = msg.asRaw();

    // Store in recipient's inbox
    const inboxEmailId = generateId();
    const inboxR2Key = `emails/${recipientHandle}/inbox/${inboxEmailId}.eml`;
    await c.env.EMAIL_STORE.put(inboxR2Key, rawMimeFinal);

    await c.env.DB.prepare(
      `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, microbuy_tx, emo_amount, created_at)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(
      inboxEmailId, recipientHandle, fromAddr, to, subject, snippet,
      inboxR2Key, rawMimeFinal.length, microbuyResult?.tx || null, effectiveEmo || 0, now,
    ).run();

    // Update daily email count
    await c.env.DB.prepare(
      `INSERT INTO daily_email_counts (handle, date, count) VALUES (?, ?, 1)
       ON CONFLICT(handle, date) DO UPDATE SET count = count + 1`
    ).bind(auth.handle, today).run();

    // Save to sender's sent folder
    const sentR2Key = `emails/${auth.handle}/sent/${emailId}.eml`;
    await c.env.EMAIL_STORE.put(sentR2Key, rawMimeFinal);

    await c.env.DB.prepare(
      `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, microbuy_tx, emo_amount, created_at)
       VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(
      emailId, auth.handle, fromAddr, to, subject, snippet,
      sentR2Key, rawMimeFinal.length, microbuyResult?.tx || null, effectiveEmo || 0, now,
    ).run();

  } else {
    // ── External sending (paid, costs 1 credit) ──
    const acct = await c.env.DB.prepare(
      'SELECT credits FROM accounts WHERE handle = ?'
    ).bind(auth.handle).first<{ credits: number }>();

    if (!acct || (acct.credits || 0) < 1) {
      return c.json({
        error: 'Insufficient credits for external email',
        credits: acct?.credits || 0,
        hint: 'Purchase credits via POST /api/credits/buy (1 credit = 1 external email)',
      }, 402);
    }

    // Static signature for external emails (no micro-buy)
    const finalBody = isPro ? body : body + buildTextSignature();
    const finalHtml = html ? (isPro ? html : html + buildHtmlSignature()) : undefined;

    if (c.env.RESEND_API_KEY) {
      try {
        const resendBody: any = {
          from: fromAddr,
          to: [to],
          subject,
          text: finalBody,
          ...(finalHtml ? { html: finalHtml } : {}),
          headers: {
            'X-NadMail-Agent': auth.handle,
            'X-NadMail-Wallet': auth.wallet,
          },
        };

        if (attachments && attachments.length > 0) {
          resendBody.attachments = attachments.map((att) => ({
            filename: att.filename,
            content: att.data,
            type: att.content_type,
          }));
        }

        if (in_reply_to) {
          const origEmail = await c.env.DB.prepare(
            'SELECT id FROM emails WHERE id = ? AND handle = ?'
          ).bind(in_reply_to, auth.handle).first<{ id: string }>();
          if (origEmail) {
            resendBody.headers['In-Reply-To'] = `<${origEmail.id}@${c.env.DOMAIN}>`;
            resendBody.headers['References'] = `<${origEmail.id}@${c.env.DOMAIN}>`;
          }
        }

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(resendBody),
        });
        if (!res.ok) {
          const err = await res.text();
          return c.json({ error: `Failed to send email: ${err}` }, 500);
        }
      } catch (e: any) {
        return c.json({ error: `Failed to send email: ${e.message}` }, 500);
      }
    } else {
      try {
        const msg = buildMime(auth.handle, fromAddr, to, subject, finalBody, finalHtml, auth.wallet, in_reply_to, attachments, c.env);
        const rawMime = msg.asRaw();
        const message = new EmailMessage(fromAddr, to, rawMime);
        await c.env.SEND_EMAIL.send(message);
      } catch (e: any) {
        return c.json({
          error: `Failed to send email: ${e.message}`,
          hint: 'External sending requires RESEND_API_KEY or a verified destination in Cloudflare Email Routing',
        }, 500);
      }
    }

    // Deduct credit
    await c.env.DB.prepare(
      'UPDATE accounts SET credits = credits - 1 WHERE handle = ?'
    ).bind(auth.handle).run();

    // Save to sender's sent folder
    const msg = buildMime(auth.handle, fromAddr, to, subject, finalBody, finalHtml, auth.wallet, in_reply_to, attachments, c.env);
    const rawMime = msg.asRaw();
    const snippet = body.slice(0, 200);
    const sentR2Key = `emails/${auth.handle}/sent/${emailId}.eml`;
    await c.env.EMAIL_STORE.put(sentR2Key, rawMime);

    await c.env.DB.prepare(
      `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, created_at)
       VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      emailId, auth.handle, fromAddr, to, subject, snippet,
      sentR2Key, rawMime.length, now,
    ).run();
  }

  // Build API response
  const response: Record<string, unknown> = {
    success: true,
    email_id: emailId,
    from: fromAddr,
    to,
    subject,
    internal: isInternal,
    attachments: attachments?.length || 0,
  };

  if (microbuyResult) {
    response.microbuy = {
      tx: microbuyResult.tx,
      amount: `${microbuyResult.totalMonSpent} MON`,
      tokens_received: `$${microbuyResult.tokenSymbol}`,
      tokens_bought: microbuyResult.tokensBought,
      price_before: microbuyResult.priceBeforeMon,
      price_after: microbuyResult.priceAfterMon,
      price_change: microbuyResult.priceChangePercent,
      emo_boost: emoAmount > 0 ? emoAmount : undefined,
    };
  }

  return c.json(response);
});

// ── Helpers ──

function buildMime(
  handle: string, from: string, to: string, subject: string,
  body: string, html: string | undefined, wallet: string,
  in_reply_to: string | undefined, attachments: Attachment[] | undefined,
  env: Env,
) {
  const msg = createMimeMessage();
  msg.setSender({ name: handle, addr: from });
  msg.setRecipient(to);
  msg.setSubject(subject);
  msg.addMessage({ contentType: 'text/plain', data: body });
  if (html) {
    msg.addMessage({ contentType: 'text/html', data: html });
  }
  msg.setHeader('X-NadMail-Agent', handle);
  msg.setHeader('X-NadMail-Wallet', wallet);

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      msg.addAttachment({
        filename: att.filename,
        contentType: att.content_type,
        data: att.data,
      });
    }
  }

  return msg;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${timestamp}-${random}`;
}
