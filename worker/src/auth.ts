import { Context, Next } from 'hono';
import { Env, AuthContext } from './types';
import { verifyMessage } from 'viem';

const NONCE_TTL = 300; // 5 分鐘過期

/**
 * 產生 SIWE nonce
 */
export async function generateNonce(kv: KVNamespace): Promise<string> {
  const nonce = crypto.randomUUID();
  await kv.put(`nonce:${nonce}`, '1', { expirationTtl: NONCE_TTL });
  return nonce;
}

/**
 * SIWE 驗證結果（區分錯誤原因）
 */
export type SiweResult =
  | { ok: true }
  | { ok: false; reason: 'no_nonce_in_message' | 'nonce_expired' | 'signature_invalid' };

/**
 * 驗證 SIWE 簽名
 * 接受客戶端簽名的完整 message，從中解析 nonce 來驗證
 * 回傳 discriminated result 以區分不同錯誤類型
 */
export async function verifySiwe(
  kv: KVNamespace,
  address: string,
  signature: string,
  message: string,
): Promise<SiweResult> {
  // 從 message 中解析 nonce
  const nonceMatch = message.match(/Nonce: ([a-f0-9-]+)/);
  if (!nonceMatch) return { ok: false, reason: 'no_nonce_in_message' };
  const nonce = nonceMatch[1];

  // 檢查 nonce 是否有效
  const stored = await kv.get(`nonce:${nonce}`);
  if (!stored) return { ok: false, reason: 'nonce_expired' };

  // 用完即刪，防止重放攻擊
  await kv.delete(`nonce:${nonce}`);

  // 驗證簽名（對客戶端提供的原始 message 驗證）
  try {
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    return valid ? { ok: true } : { ok: false, reason: 'signature_invalid' };
  } catch {
    return { ok: false, reason: 'signature_invalid' };
  }
}

/**
 * 建構 SIWE 標準訊息
 */
export function buildSiweMessage(address: string, nonce: string, domain: string): string {
  const now = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to BaseMail - Email for AI Agents on Base',
    '',
    `URI: https://${domain}`,
    'Version: 1',
    `Chain ID: 8453`,
    `Nonce: ${nonce}`,
    `Issued At: ${now}`,
  ].join('\n');
}

/**
 * 簡易 JWT 產生（用 HMAC-SHA256）
 */
export async function createToken(payload: AuthContext, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 86400000 })); // 24hr
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return `${data}.${signature}`;
}

/**
 * 驗證 JWT
 */
export async function verifyToken(token: string, secret: string): Promise<AuthContext | null> {
  try {
    const [header, body, signature] = token.split('.');
    const data = `${header}.${body}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;

    const payload = JSON.parse(atob(body));
    if (payload.exp < Date.now()) return null;

    return { wallet: payload.wallet, handle: payload.handle };
  } catch {
    return null;
  }
}

/**
 * Hono 中介軟體：驗證 JWT 並注入 auth context
 */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization token' }, 401);
    }

    const token = authHeader.slice(7);
    const secret = c.env.JWT_SECRET!;
    const auth = await verifyToken(token, secret);

    if (!auth) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    c.set('auth', auth);
    await next();
  };
}
