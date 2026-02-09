/**
 * Email send logic — shared by HTTP route and $DIPLOMAT agent
 * sendInternalEmail: @nadmail.ai → @nadmail.ai (micro-buy → dynamic signature → D1/R2)
 * sendExternalEmail: @nadmail.ai → external (Resend API, static signature)
 */

import { createMimeMessage } from 'mimetext';
import { Env } from './types';
import { microBuyWithPrice, type MicroBuyResult } from './nadfun';
import {
  buildTextSignature,
  buildTextSignatureWithPrice,
} from './signature';

export interface SendInternalParams {
  fromHandle: string;
  fromWallet: string;
  to: string;
  subject: string;
  body: string;
  in_reply_to?: string;
}

export interface SendInternalResult {
  success: boolean;
  email_id: string;
  microbuy?: MicroBuyResult;
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${timestamp}-${random}`;
}

export async function sendInternalEmail(
  env: Env,
  params: SendInternalParams,
): Promise<SendInternalResult> {
  const { fromHandle, fromWallet, to, subject, body, in_reply_to } = params;
  const fromAddr = `${fromHandle}@${env.DOMAIN}`;
  const emailId = generateId();
  const now = Math.floor(Date.now() / 1000);

  const recipientHandle = to.split('@')[0].toLowerCase();

  const recipient = await env.DB.prepare(
    'SELECT handle, token_address, token_symbol FROM accounts WHERE handle = ?'
  ).bind(recipientHandle).first<{ handle: string; token_address: string | null; token_symbol: string | null }>();

  if (!recipient) {
    throw new Error(`Recipient not found: ${to}`);
  }

  // ── Micro-buy FIRST (so we have price data for signature) ──
  let microbuyResult: MicroBuyResult | undefined;
  if (recipient.token_address) {
    try {
      microbuyResult = await microBuyWithPrice(
        recipient.token_address,
        recipient.token_symbol || recipientHandle.toUpperCase(),
        fromWallet,
        env,
      );
    } catch (e: any) {
      console.log(`[send-internal] Micro-buy failed: ${e.message}`);
    }
  }

  // ── Build MIME with dynamic signature ──
  const textSig = microbuyResult ? buildTextSignatureWithPrice(microbuyResult) : buildTextSignature();
  const finalBody = body + textSig;

  const msg = createMimeMessage();
  msg.setSender({ name: fromHandle, addr: fromAddr });
  msg.setRecipient(to);
  msg.setSubject(subject);
  msg.addMessage({ contentType: 'text/plain', data: finalBody });
  msg.setHeader('X-NadMail-Agent', fromHandle);
  msg.setHeader('X-NadMail-Wallet', fromWallet);

  if (in_reply_to) {
    const origEmail = await env.DB.prepare(
      'SELECT id FROM emails WHERE id = ? AND handle = ?'
    ).bind(in_reply_to, fromHandle).first<{ id: string }>();
    if (origEmail) {
      msg.setHeader('In-Reply-To', `<${origEmail.id}@${env.DOMAIN}>`);
      msg.setHeader('References', `<${origEmail.id}@${env.DOMAIN}>`);
    }
  }

  const rawMime = msg.asRaw();
  const snippet = body.slice(0, 200);

  // Store in recipient's inbox
  const inboxEmailId = generateId();
  const inboxR2Key = `emails/${recipientHandle}/inbox/${inboxEmailId}.eml`;
  await env.EMAIL_STORE.put(inboxR2Key, rawMime);

  await env.DB.prepare(
    `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, microbuy_tx, created_at)
     VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    inboxEmailId, recipientHandle, fromAddr, to, subject, snippet,
    inboxR2Key, rawMime.length, microbuyResult?.tx || null, now,
  ).run();

  // Save to sender's sent folder
  const sentR2Key = `emails/${fromHandle}/sent/${emailId}.eml`;
  await env.EMAIL_STORE.put(sentR2Key, rawMime);

  await env.DB.prepare(
    `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, microbuy_tx, created_at)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(
    emailId, fromHandle, fromAddr, to, subject, snippet,
    sentR2Key, rawMime.length, microbuyResult?.tx || null, now,
  ).run();

  // Update daily email count
  const today = new Date().toISOString().split('T')[0];
  await env.DB.prepare(
    `INSERT INTO daily_email_counts (handle, date, count) VALUES (?, ?, 1)
     ON CONFLICT(handle, date) DO UPDATE SET count = count + 1`
  ).bind(fromHandle, today).run();

  return {
    success: true,
    email_id: emailId,
    microbuy: microbuyResult,
  };
}

/**
 * Send email to external address via Resend API
 * Also saves to sender's sent folder in D1/R2
 */
export async function sendExternalEmail(
  env: Env,
  params: SendInternalParams,
): Promise<SendInternalResult> {
  const { fromHandle, fromWallet, to, subject, body, in_reply_to } = params;
  const fromAddr = `${fromHandle}@${env.DOMAIN}`;
  const emailId = generateId();
  const now = Math.floor(Date.now() / 1000);

  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured, cannot send external email');
  }

  // Build reply headers
  const headers: Record<string, string> = {
    'X-NadMail-Agent': fromHandle,
    'X-NadMail-Wallet': fromWallet,
  };

  if (in_reply_to) {
    const origEmail = await env.DB.prepare(
      'SELECT id FROM emails WHERE id = ? AND handle = ?'
    ).bind(in_reply_to, fromHandle).first<{ id: string }>();
    if (origEmail) {
      headers['In-Reply-To'] = `<${origEmail.id}@${env.DOMAIN}>`;
      headers['References'] = `<${origEmail.id}@${env.DOMAIN}>`;
    }
  }

  // Send via Resend
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddr,
      to: [to],
      subject,
      text: body,
      headers,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend failed: ${err}`);
  }

  // Build MIME for sent folder storage
  const msg = createMimeMessage();
  msg.setSender({ name: fromHandle, addr: fromAddr });
  msg.setRecipient(to);
  msg.setSubject(subject);
  msg.addMessage({ contentType: 'text/plain', data: body });
  const rawMime = msg.asRaw();
  const snippet = body.slice(0, 200);

  // Save to sender's sent folder
  const sentR2Key = `emails/${fromHandle}/sent/${emailId}.eml`;
  await env.EMAIL_STORE.put(sentR2Key, rawMime);

  await env.DB.prepare(
    `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, created_at)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(emailId, fromHandle, fromAddr, to, subject, snippet, sentR2Key, rawMime.length, now).run();

  return { success: true, email_id: emailId };
}
