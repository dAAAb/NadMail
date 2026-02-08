/**
 * BaseMail ClawHub Skill Handlers
 *
 * 這些 handler 會被 AI Agent 透過 ClawHub 呼叫
 * 每個 handler 對應一個 skill command
 */

const API_BASE = 'https://api.basemail.ai';

interface SkillContext {
  wallet: {
    address: string;
    signMessage: (message: string) => Promise<string>;
  };
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };
}

/**
 * 取得或刷新 auth token
 */
async function getToken(ctx: SkillContext): Promise<string> {
  // 先檢查快取的 token
  const cached = await ctx.storage.get('basemail_token');
  if (cached) return cached;

  // 1. 取得 nonce
  const nonceRes = await fetch(`${API_BASE}/api/auth/nonce`);
  const { nonce } = await nonceRes.json() as { nonce: string };

  // 2. 取得要簽名的訊息
  const msgRes = await fetch(`${API_BASE}/api/auth/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ctx.wallet.address, nonce }),
  });
  const { message } = await msgRes.json() as { message: string };

  // 3. 簽名
  const signature = await ctx.wallet.signMessage(message);

  // 4. 驗證並取得 token
  const verifyRes = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ctx.wallet.address, signature, message }),
  });
  const data = await verifyRes.json() as { token: string };

  // 快取 token
  await ctx.storage.set('basemail_token', data.token);
  return data.token;
}

/**
 * 帶認證的 API 呼叫
 */
async function apiCall(ctx: SkillContext, method: string, path: string, body?: any): Promise<any> {
  const token = await getToken(ctx);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ─── Skill Command Handlers ───

export async function register(ctx: SkillContext, params: { handle: string; basename?: string }) {
  return apiCall(ctx, 'POST', '/api/register', params);
}

export async function send(ctx: SkillContext, params: { to: string; subject: string; body: string; html?: string }) {
  return apiCall(ctx, 'POST', '/api/send', params);
}

export async function inbox(ctx: SkillContext, params: { limit?: number; folder?: string }) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.folder) query.set('folder', params.folder);
  return apiCall(ctx, 'GET', `/api/inbox?${query.toString()}`);
}

export async function read(ctx: SkillContext, params: { id: string }) {
  return apiCall(ctx, 'GET', `/api/inbox/${params.id}`);
}

export async function identity(_ctx: SkillContext, params: { query: string }) {
  // Identity 查詢不需要驗證
  const isAddress = params.query.startsWith('0x');
  const path = isAddress ? `/api/identity/wallet/${params.query}` : `/api/identity/${params.query}`;
  const res = await fetch(`${API_BASE}${path}`);
  return res.json();
}
