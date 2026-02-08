import { Hono } from 'hono';
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Env } from '../types';
import { authMiddleware } from '../auth';

// ── USDC Hackathon (TESTNET ONLY — Base Sepolia) ──
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export const sendRoutes = new Hono<{ Bindings: Env }>();

sendRoutes.use('/*', authMiddleware());

// ── Email Signature (appended for free-tier users) ──
const TEXT_SIGNATURE = `\n\n--\nSent via BaseMail.ai — Email Identity for AI Agents on Base\nhttps://basemail.ai`;

const HTML_SIGNATURE = `<br><br><div style="border-top:1px solid #333;padding-top:12px;margin-top:24px;font-size:12px;color:#888;font-family:sans-serif;">Sent via <a href="https://basemail.ai" style="color:#3B82F6;text-decoration:none;font-weight:bold;">BaseMail.ai</a> — Email Identity for AI Agents on Base</div>`;

interface Attachment {
  filename: string;
  content_type: string;
  data: string; // base64 encoded
}

interface UsdcPayment {
  tx_hash: string;
  amount: string; // human-readable e.g. "10.00"
}

/**
 * POST /api/send
 * Send email from Agent's @basemail.ai address
 *
 * Body: {
 *   to: string,
 *   subject: string,
 *   body: string,
 *   html?: string,
 *   in_reply_to?: string,       // email ID to reply to (adds In-Reply-To header)
 *   attachments?: Attachment[],  // base64-encoded file attachments
 * }
 *
 * Routing:
 * - @basemail.ai -> @basemail.ai: internal delivery (direct D1/R2 storage)
 * - @basemail.ai -> external: via Resend API or Cloudflare send_email
 */
sendRoutes.post('/', async (c) => {
  const auth = c.get('auth');

  if (!auth.handle) {
    return c.json({ error: 'No email registered for this wallet' }, 403);
  }

  const { to, subject, body, html, in_reply_to, attachments, usdc_payment } = await c.req.json<{
    to: string;
    subject: string;
    body: string;
    html?: string;
    in_reply_to?: string;
    attachments?: Attachment[];
    usdc_payment?: UsdcPayment;
  }>();

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

  // ── USDC Payment Verification (Base Sepolia TESTNET) ──
  let verifiedUsdc: { amount: string; tx_hash: string } | null = null;

  if (usdc_payment?.tx_hash) {
    try {
      const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
      const receipt = await client.waitForTransactionReceipt({
        hash: usdc_payment.tx_hash as Hex,
        timeout: 15_000,
      });

      if (receipt.status !== 'success') {
        return c.json({ error: 'USDC payment transaction failed on-chain' }, 400);
      }

      // Parse Transfer events from USDC contract
      const transferLog = receipt.logs.find(
        (log) => log.address.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
      );

      if (!transferLog || !transferLog.topics[1] || !transferLog.topics[2]) {
        return c.json({ error: 'No USDC Transfer event found in transaction' }, 400);
      }

      const txFrom = ('0x' + transferLog.topics[1].slice(26)).toLowerCase();
      const txTo = ('0x' + transferLog.topics[2].slice(26)).toLowerCase();
      const txAmount = BigInt(transferLog.data);
      const humanAmount = (Number(txAmount) / 1e6).toFixed(2);

      // Verify sender matches
      if (txFrom !== auth.wallet.toLowerCase()) {
        return c.json({ error: 'USDC sender does not match authenticated wallet' }, 400);
      }

      // Resolve recipient wallet
      const recipientHandle = to.split('@')[0].toLowerCase();
      const recipientAcct = await c.env.DB.prepare(
        'SELECT wallet FROM accounts WHERE handle = ? OR wallet = ?'
      ).bind(recipientHandle, recipientHandle).first<{ wallet: string }>();

      if (recipientAcct && txTo !== recipientAcct.wallet.toLowerCase()) {
        return c.json({ error: 'USDC recipient does not match email recipient wallet' }, 400);
      }

      verifiedUsdc = { amount: humanAmount, tx_hash: usdc_payment.tx_hash };
    } catch (e: any) {
      return c.json({ error: `USDC verification failed: ${e.message}` }, 400);
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

  // Append signature for free-tier users
  const finalBody = isPro ? body : body + TEXT_SIGNATURE;
  const finalHtml = html ? (isPro ? html : html + HTML_SIGNATURE) : undefined;

  // Build MIME message
  const msg = createMimeMessage();
  msg.setSender({ name: auth.handle, addr: fromAddr });
  msg.setRecipient(to);
  msg.setSubject(subject);
  msg.addMessage({ contentType: 'text/plain', data: finalBody });
  if (finalHtml) {
    msg.addMessage({ contentType: 'text/html', data: finalHtml });
  }
  msg.setHeader('X-BaseMail-Agent', auth.handle);
  msg.setHeader('X-BaseMail-Wallet', auth.wallet);

  // USDC payment headers
  if (verifiedUsdc) {
    msg.setHeader('X-BaseMail-USDC-Payment', `${verifiedUsdc.amount} USDC`);
    msg.setHeader('X-BaseMail-USDC-TxHash', verifiedUsdc.tx_hash);
    msg.setHeader('X-BaseMail-USDC-Network', 'Base Sepolia (Testnet)');
  }

  // Reply headers
  if (in_reply_to) {
    const origEmail = await c.env.DB.prepare(
      'SELECT id, from_addr, subject FROM emails WHERE id = ? AND handle = ?'
    ).bind(in_reply_to, auth.handle).first<{ id: string; from_addr: string; subject: string }>();

    if (origEmail) {
      const messageId = `<${origEmail.id}@${c.env.DOMAIN}>`;
      msg.setHeader('In-Reply-To', messageId);
      msg.setHeader('References', messageId);
    }
  }

  // Attachments
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      msg.addAttachment({
        filename: att.filename,
        contentType: att.content_type,
        data: att.data,
      });
    }
  }

  const rawMime = msg.asRaw();
  const snippet = body.slice(0, 200);

  // Internal vs external routing
  const isInternal = to.toLowerCase().endsWith(`@${c.env.DOMAIN}`);

  if (isInternal) {
    // ── Internal delivery: store directly in recipient's inbox ──
    let recipientHandle = to.split('@')[0].toLowerCase();

    let recipient = await c.env.DB.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(recipientHandle).first<{ handle: string }>();

    // 0x 地址 fallback：查 wallet 欄位找到 basename 帳號
    if (!recipient && /^0x[a-f0-9]{40}$/.test(recipientHandle)) {
      recipient = await c.env.DB.prepare(
        'SELECT handle FROM accounts WHERE wallet = ?'
      ).bind(recipientHandle).first<{ handle: string }>();
      if (recipient) {
        recipientHandle = recipient.handle;
      }
    }

    if (!recipient) {
      // 未註冊收件者 — 僅 0x 地址可預存
      const is0xAddress = /^0x[a-f0-9]{40}$/.test(recipientHandle);
      if (!is0xAddress) {
        return c.json({ error: `Recipient not found: ${to}` }, 404);
      }

      // 預存機制：限制每個 0x 地址最多 10 封，30 天 TTL
      const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
      const pendingCount = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM emails WHERE handle = ? AND created_at > ?'
      ).bind(recipientHandle, thirtyDaysAgo).first<{ count: number }>();

      if (pendingCount && pendingCount.count >= 10) {
        return c.json({ error: 'Pre-storage limit reached for this address (max 10 emails)' }, 429);
      }

      // 限制 1MB
      if (rawMime.length > 1 * 1024 * 1024) {
        return c.json({ error: 'Email too large for pre-storage (max 1MB)' }, 413);
      }
    }

    const inboxEmailId = generateId();
    const inboxR2Key = `emails/${recipientHandle}/inbox/${inboxEmailId}.eml`;
    await c.env.EMAIL_STORE.put(inboxR2Key, rawMime);

    await c.env.DB.prepare(
      `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, created_at, usdc_amount, usdc_tx)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(
      inboxEmailId,
      recipientHandle,
      fromAddr,
      to,
      subject,
      snippet,
      inboxR2Key,
      rawMime.length,
      now,
      verifiedUsdc?.amount || null,
      verifiedUsdc?.tx_hash || null,
    ).run();
  } else {
    // ── External sending (paid, costs 1 credit) ──
    const acct = await c.env.DB.prepare(
      'SELECT credits FROM accounts WHERE handle = ?'
    ).bind(auth.handle).first<{ credits: number }>();

    if (!acct || acct.credits < 1) {
      return c.json({
        error: 'Insufficient credits for external email',
        credits: acct?.credits || 0,
        hint: 'Purchase credits via POST /api/credits/buy (1 credit = 1 external email, 0.001 ETH = 1000 credits)',
      }, 402);
    }

    if (c.env.RESEND_API_KEY) {
      try {
        const resendBody: any = {
          from: fromAddr,
          to: [to],
          subject,
          text: finalBody,
          ...(finalHtml ? { html: finalHtml } : {}),
          headers: {
            'X-BaseMail-Agent': auth.handle,
            'X-BaseMail-Wallet': auth.wallet,
          },
        };

        // Add attachments to Resend payload
        if (attachments && attachments.length > 0) {
          resendBody.attachments = attachments.map((att) => ({
            filename: att.filename,
            content: att.data,
            type: att.content_type,
          }));
        }

        // Add reply headers to Resend
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
        const message = new EmailMessage(fromAddr, to, rawMime);
        await c.env.SEND_EMAIL.send(message);
      } catch (e: any) {
        return c.json({
          error: `Failed to send email: ${e.message}`,
          hint: 'External sending requires RESEND_API_KEY or a verified destination in Cloudflare Email Routing',
        }, 500);
      }
    }
  }

  // Deduct credit for external sends
  if (!isInternal) {
    await c.env.DB.prepare(
      'UPDATE accounts SET credits = credits - 1 WHERE handle = ?'
    ).bind(auth.handle).run();

    const txId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    await c.env.DB.prepare(
      `INSERT INTO credit_transactions (id, handle, type, amount, tx_hash, price_wei, created_at)
       VALUES (?, ?, 'send_external', -1, NULL, NULL, ?)`
    ).bind(txId, auth.handle, Math.floor(Date.now() / 1000)).run();
  }

  // Save to sender's sent folder
  const sentR2Key = `emails/${auth.handle}/sent/${emailId}.eml`;
  await c.env.EMAIL_STORE.put(sentR2Key, rawMime);

  await c.env.DB.prepare(
    `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, created_at, usdc_amount, usdc_tx)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).bind(
    emailId,
    auth.handle,
    fromAddr,
    to,
    subject,
    snippet,
    sentR2Key,
    rawMime.length,
    now,
    verifiedUsdc?.amount || null,
    verifiedUsdc?.tx_hash || null,
  ).run();

  return c.json({
    success: true,
    email_id: emailId,
    from: fromAddr,
    to,
    subject,
    internal: isInternal,
    attachments: attachments?.length || 0,
    ...(verifiedUsdc ? {
      usdc_payment: {
        verified: true,
        amount: verifiedUsdc.amount,
        tx_hash: verifiedUsdc.tx_hash,
        network: 'Base Sepolia (Testnet)',
      },
    } : {}),
  });
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${timestamp}-${random}`;
}
