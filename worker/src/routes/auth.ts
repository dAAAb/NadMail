import { Hono } from 'hono';
import { Env } from '../types';
import { generateNonce, verifySiwe, createToken, buildSiweMessage } from '../auth';
import type { SiweResult } from '../auth';
import { resolveHandle, verifyBasenameOwnership } from '../basename-lookup';
import type { Address } from 'viem';

const SIWE_ERROR_MESSAGES: Record<string, string> = {
  no_nonce_in_message: 'SIWE message is malformed — no nonce found. Use the exact message returned by POST /api/auth/start.',
  nonce_expired: 'Nonce has expired (5 min TTL) or was already used. Call POST /api/auth/start again for a fresh nonce.',
  signature_invalid: 'Signature verification failed. Ensure you sign the exact message string with the correct private key (personal_sign / EIP-191).',
};

export const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/auth/start
 * 合併 nonce + message 為一步（Agent 友好）
 * Body: { address: "0x..." }
 * Response: { nonce, message }
 */
authRoutes.post('/start', async (c) => {
  const { address } = await c.req.json<{ address: string }>();

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ error: 'Valid Ethereum address is required. Example: { "address": "0x..." }' }, 400);
  }

  const nonce = await generateNonce(c.env.NONCE_KV);
  const message = buildSiweMessage(address, nonce, c.env.DOMAIN);

  return c.json({ nonce, message });
});

/**
 * POST /api/auth/agent-register
 * 一步完成 verify + register（Agent 友好）
 * Body: { address: "0x...", signature: "0x...", message: "..." }
 * Response: { token, email, handle, wallet, registered: true }
 *
 * - 如果錢包已註冊：回傳現有帳號 + 新 token
 * - 如果錢包未註冊：自動註冊 + 回傳新帳號
 */
authRoutes.post('/agent-register', async (c) => {
  const { address, signature, message, basename: requestedBasename } = await c.req.json<{
    address: string;
    signature: string;
    message: string;
    basename?: string; // optional: e.g. "alice.base.eth" — 直接指定 Basename
  }>();

  if (!address || !signature || !message) {
    return c.json({
      error: 'address, signature, and message are required',
      hint: 'Step 1: POST /api/auth/start { address } to get the message. Step 2: Sign it with your private key. Step 3: Submit here. Optional: pass "basename": "yourname.base.eth" to register with your Basename.',
    }, 400);
  }

  // Verify SIWE signature（細分錯誤原因）
  const result = await verifySiwe(c.env.NONCE_KV, address, signature, message);
  if (!result.ok) {
    return c.json({
      error: SIWE_ERROR_MESSAGES[result.reason],
      code: result.reason,
    }, 401);
  }

  const wallet = address.toLowerCase();
  const secret = c.env.JWT_SECRET!;

  // Check if wallet already registered
  const existingAccount = await c.env.DB.prepare(
    'SELECT handle, basename, tier FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; basename: string | null; tier: string }>();

  if (existingAccount) {
    // Already registered — just return token + existing info
    const token = await createToken({ wallet, handle: existingAccount.handle }, secret);
    return c.json({
      token,
      email: `${existingAccount.handle}@${c.env.DOMAIN}`,
      handle: existingAccount.handle,
      wallet,
      basename: existingAccount.basename,
      tier: existingAccount.tier || 'free',
      registered: true,
      new_account: false,
    });
  }

  // Not registered — auto-register
  let handle: string;
  let resolvedBasename: string | null = null;
  let source: 'basename' | 'address' = 'address';

  if (requestedBasename && requestedBasename.endsWith('.base.eth')) {
    // Agent 指定了 Basename → 驗證 on-chain 所有權
    const ownership = await verifyBasenameOwnership(requestedBasename, wallet);
    if (!ownership.valid) {
      return c.json({ error: ownership.error }, 403);
    }
    handle = ownership.name;
    resolvedBasename = requestedBasename;
    source = 'basename';
  } else {
    // 自動偵測（reverse resolution → fallback 0x address）
    const resolved = await resolveHandle(wallet as Address);
    handle = resolved.handle;
    resolvedBasename = resolved.basename;
    source = resolved.source;
  }

  // Check if handle is already taken
  const handleTaken = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(handle).first();

  if (handleTaken) {
    return c.json({ error: 'This identity is already registered by another wallet' }, 409);
  }

  // Create account
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, basename, tx_hash, created_at)
     VALUES (?, ?, ?, NULL, ?)`
  ).bind(handle, wallet, resolvedBasename, Math.floor(Date.now() / 1000)).run();

  // Migrate pre-stored emails from 0x handle to basename handle
  let migratedCount = 0;
  if (handle !== wallet) {
    const migrated = await c.env.DB.prepare(
      'UPDATE emails SET handle = ? WHERE handle = ?'
    ).bind(handle, wallet).run();
    migratedCount = migrated.meta?.changes || 0;
  }

  const token = await createToken({ wallet, handle }, secret);

  // Count pending emails
  const pendingResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM emails WHERE handle = ?'
  ).bind(handle).first<{ count: number }>();

  const response: Record<string, any> = {
    token,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet,
    basename: resolvedBasename,
    source,
    tier: 'free',
    registered: true,
    new_account: true,
    pending_emails: pendingResult?.count || 0,
    migrated_emails: migratedCount,
  };

  // 如果用 0x handle 註冊 → 引導升級到 Basename
  if (source === 'address') {
    response.upgrade_hint = {
      message: 'Want a shorter email like alice@basemail.ai? You can upgrade your handle anytime.',
      options: [
        {
          action: 'claim_existing_basename',
          description: 'If you already own a Basename, claim it now.',
          method: 'PUT',
          url: '/api/register/upgrade',
          body: { basename: 'yourname.base.eth' },
        },
        {
          action: 'buy_basename',
          description: 'Buy a new Basename on-chain (we pay gas).',
          method: 'PUT',
          url: '/api/register/upgrade',
          body: { auto_basename: true, basename_name: 'desiredname' },
          price_check: 'GET /api/register/price/:name',
        },
      ],
    };
  }

  return c.json(response, 201);
});

/**
 * GET /api/auth/nonce
 */
authRoutes.get('/nonce', async (c) => {
  const nonce = await generateNonce(c.env.NONCE_KV);
  return c.json({ nonce });
});

/**
 * POST /api/auth/message
 */
authRoutes.post('/message', async (c) => {
  const { address, nonce } = await c.req.json<{ address: string; nonce: string }>();

  if (!address || !nonce) {
    return c.json({ error: 'address and nonce are required' }, 400);
  }

  const message = buildSiweMessage(address, nonce, c.env.DOMAIN);
  return c.json({ message });
});

/**
 * POST /api/auth/verify
 * Verify SIWE signature, auto-detect Basename, return JWT
 */
authRoutes.post('/verify', async (c) => {
  const { address, signature, message } = await c.req.json<{
    address: string;
    signature: string;
    message: string;
  }>();

  if (!address || !signature || !message) {
    return c.json({ error: 'address, signature, and message are required' }, 400);
  }

  const result = await verifySiwe(c.env.NONCE_KV, address, signature, message);
  if (!result.ok) {
    return c.json({
      error: SIWE_ERROR_MESSAGES[result.reason],
      code: result.reason,
    }, 401);
  }

  const wallet = address.toLowerCase();

  // Check if wallet already registered
  const account = await c.env.DB.prepare(
    'SELECT handle, basename, tier FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; basename: string | null; tier: string }>();

  // Always resolve Basename（不管是否已註冊，都偵測 Basename）
  const resolved = await resolveHandle(wallet as Address);
  let basename = resolved.basename;
  let suggestedHandle: string | null = null;
  let suggestedSource: string | null = null;

  // 已註冊但用 0x handle，且現在有 Basename → 可升級
  let upgradeAvailable = false;
  let hasBasenameNFT = resolved.has_basename_nft || false;
  if (account) {
    basename = resolved.basename || account.basename;
    if (/^0x/i.test(account.handle) && resolved.basename && resolved.handle !== account.handle) {
      upgradeAvailable = true;
      suggestedHandle = resolved.handle;
      suggestedSource = resolved.source;
    }
    // Even if reverse resolution didn't find a name, NFT ownership means they have one
    if (/^0x/i.test(account.handle) && !resolved.basename && hasBasenameNFT) {
      upgradeAvailable = true;
    }
  } else {
    suggestedHandle = resolved.handle;
    suggestedSource = resolved.source;
  }

  const secret = c.env.JWT_SECRET!;
  const token = await createToken(
    { wallet, handle: account?.handle || '' },
    secret,
  );

  // Count pre-stored emails for unregistered users
  let pendingEmails = 0;
  if (!account && suggestedHandle) {
    const result = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM emails WHERE handle = ? OR handle = ?'
    ).bind(suggestedHandle, wallet).first<{ count: number }>();
    pendingEmails = result?.count || 0;
  }

  return c.json({
    token,
    wallet,
    handle: account?.handle || null,
    registered: !!account,
    basename,
    tier: account?.tier || 'free',
    suggested_handle: suggestedHandle,
    suggested_source: suggestedSource,
    suggested_email: suggestedHandle ? `${suggestedHandle}@${c.env.DOMAIN}` : null,
    pending_emails: pendingEmails,
    upgrade_available: upgradeAvailable,
    has_basename_nft: hasBasenameNFT,
  });
});
