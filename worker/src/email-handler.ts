/**
 * Cloudflare Email Worker — 處理所有寄到 @basemail.ai 的來信
 *
 * 流程：
 * 1. 解析收件地址的 handle（支援 Basename handle 或 0x 地址）
 * 2. 查詢 D1 確認此 handle 已註冊
 * 3. 未註冊 → 拒絕（外部來信不預存，防 spam）
 * 4. 儲存原始郵件到 R2
 * 5. 在 D1 中建立郵件索引
 * 6. 如有 webhook，通知 Agent
 */

import { Env } from './types';

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
) {
  const toAddr = message.to;
  const fromAddr = message.from;

  // 解析 handle（支援 basename handle 或 0x 地址格式）
  const handle = extractHandle(toAddr, env.DOMAIN);
  if (!handle) {
    message.setReject(`Invalid recipient address: ${toAddr}`);
    return;
  }

  // 確認此 handle 已註冊
  let account = await env.DB.prepare(
    'SELECT handle, webhook_url FROM accounts WHERE handle = ?'
  ).bind(handle).first<{ handle: string; webhook_url: string | null }>();

  // 0x 地址 fallback：用 wallet 欄位查找已註冊帳號（如 basename 用戶）
  if (!account && /^0x[a-f0-9]{40}$/.test(handle)) {
    account = await env.DB.prepare(
      'SELECT handle, webhook_url FROM accounts WHERE wallet = ?'
    ).bind(handle).first<{ handle: string; webhook_url: string | null }>();
  }

  if (!account) {
    // 外部來信不預存，直接拒絕
    message.setReject(`Mailbox not found: ${toAddr}`);
    return;
  }

  // 使用帳號的 handle（可能是 basename）而非原始收件地址
  const deliverHandle = account.handle;

  // 讀取郵件內容
  const rawEmail = await streamToText(message.raw);
  const emailId = generateId();

  // 解析 subject
  const subject = message.headers.get('subject') || '(no subject)';

  // 取得預覽文字（從原始郵件中擷取簡單文字）
  const snippet = extractSnippet(rawEmail);

  // 儲存原始郵件到 R2
  const r2Key = `emails/${deliverHandle}/inbox/${emailId}.eml`;
  await env.EMAIL_STORE.put(r2Key, rawEmail);

  // 在 D1 建立索引
  await env.DB.prepare(
    `INSERT INTO emails (id, handle, folder, from_addr, to_addr, subject, snippet, r2_key, size, read, created_at)
     VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(
    emailId,
    deliverHandle,
    fromAddr,
    toAddr,
    subject,
    snippet,
    r2Key,
    message.rawSize,
    Math.floor(Date.now() / 1000),
  ).run();

  // 如有 webhook，非同步通知 Agent
  if (account.webhook_url) {
    ctx.waitUntil(notifyWebhook(account.webhook_url, {
      event: 'new_email',
      email_id: emailId,
      from: fromAddr,
      to: toAddr,
      subject,
      snippet,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }
}

function extractHandle(toAddr: string, domain: string): string | null {
  const escapedDomain = domain.replace(/\./g, '\\.');
  // 支援兩種 handle 格式：
  // 1. Basename handle: alice@basemail.ai (a-z, 0-9, _, -)
  // 2. 0x 地址: 0x4bbd...9fe@basemail.ai (42 字元)
  const match = toAddr.match(new RegExp(`^(0x[a-fA-F0-9]{40}|[a-z0-9][a-z0-9_-]*[a-z0-9])@${escapedDomain}$`, 'i'));
  return match ? match[1].toLowerCase() : null;
}

async function streamToText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

function extractSnippet(rawEmail: string): string {
  // 找 text/plain part，處理 multipart 和 quoted-printable
  const boundaryMatch = rawEmail.match(/boundary="?([^"\r\n;]+)"?/);
  let body = '';

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawEmail.split('--' + boundary);
    for (const part of parts) {
      if (part.toLowerCase().includes('content-type: text/plain')) {
        const sep = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
        const start = part.indexOf(sep);
        if (start !== -1) {
          body = part.slice(start + sep.length);
          break;
        }
      }
    }
  }

  if (!body) {
    const bodyStart = rawEmail.indexOf('\r\n\r\n');
    if (bodyStart === -1) return '';
    body = rawEmail.slice(bodyStart + 4);
  }

  // Decode quoted-printable
  body = body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Try UTF-8 decode
  try {
    const bytes = new Uint8Array([...body].map(c => c.charCodeAt(0)));
    body = new TextDecoder('utf-8').decode(bytes);
  } catch {}

  // 移除 HTML 標籤和多餘空白
  body = body.replace(/<[^>]*>/g, '').replace(/--$/, '').trim();
  return body.slice(0, 200);
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${timestamp}-${random}`;
}

async function notifyWebhook(url: string, payload: Record<string, any>): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // webhook 失敗不影響郵件接收
  }
}
