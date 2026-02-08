import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware, createToken } from '../auth';
import { resolveHandle, basenameToHandle, verifyBasenameOwnership } from '../basename-lookup';
import { registerBasename, isBasenameAvailable, getBasenamePrice } from '../basename';
import type { Hex, Address } from 'viem';
import { formatEther } from 'viem';

export const registerRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/register
 * Register a @basemail.ai email address.
 * Handle is auto-assigned: Basename → basename handle, no Basename → 0x address.
 *
 * Body: {
 *   basename?: string,        // e.g. "alice.base.eth" — claim existing Basename (verified on-chain)
 *   auto_basename?: boolean,  // buy a Basename if you don't have one (optional)
 *   basename_name?: string,   // desired Basename name (required if auto_basename)
 * }
 * Auth: Bearer JWT (from SIWE verify)
 */
registerRoutes.post('/', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{
    basename?: string;         // e.g. "littl3lobst3r.base.eth"
    auto_basename?: boolean;
    basename_name?: string;
  }>().catch(() => ({}));

  // Check if wallet already registered
  const walletAccount = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first();

  if (walletAccount) {
    return c.json({
      error: 'This wallet already has a registered email',
      existing_handle: (walletAccount as { handle: string }).handle,
    }, 409);
  }

  // Determine handle: explicit basename > auto_basename > resolveHandle
  let handle: string;
  let resolvedBasename: string | null = null;
  let source: 'basename' | 'address' = 'address';

  if (body.basename && body.basename.endsWith('.base.eth')) {
    // Agent 指定了已有的 Basename → 驗證 on-chain 所有權
    const ownership = await verifyBasenameOwnership(body.basename, auth.wallet);
    if (!ownership.valid) {
      return c.json({ error: ownership.error }, 403);
    }
    handle = ownership.name;
    resolvedBasename = body.basename;
    source = 'basename';
  } else if (body.auto_basename) {
    // 購買新 Basename
    if (!c.env.WALLET_PRIVATE_KEY) {
      return c.json({ error: 'Basename auto-registration is not configured' }, 503);
    }
    const name = body.basename_name;
    if (!name || !isValidBasename(name)) {
      return c.json({ error: 'basename_name is required (3-32 chars, a-z, 0-9, -)' }, 400);
    }
    try {
      const result = await registerBasename(
        name,
        auth.wallet as Address,
        c.env.WALLET_PRIVATE_KEY as Hex,
        1,
      );
      handle = name;
      resolvedBasename = result.fullName;
      source = 'basename';
    } catch (e: any) {
      return c.json({ error: `Basename registration failed: ${e.message}` }, 500);
    }
  } else {
    // Auto-detect via reverse resolution
    const resolved = await resolveHandle(auth.wallet as Address);
    handle = resolved.handle;
    resolvedBasename = resolved.basename;
    source = resolved.source;
  }

  // Check if this handle is already taken (shouldn't happen for 0x addresses)
  const existing = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(handle).first();

  if (existing) {
    return c.json({ error: 'This identity is already registered' }, 409);
  }

  // Create account
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, basename, tx_hash, created_at)
     VALUES (?, ?, ?, NULL, ?)`
  ).bind(
    handle,
    auth.wallet,
    resolvedBasename,
    Math.floor(Date.now() / 1000),
  ).run();

  // Issue new JWT with handle
  const secret = c.env.JWT_SECRET!;
  const newToken = await createToken(
    { wallet: auth.wallet, handle },
    secret,
  );

  // 遷移預存信件：如果 handle 是 basename，把 0x 地址下的預存信件搬過來
  const walletLower = auth.wallet.toLowerCase();
  let migratedCount = 0;
  if (handle !== walletLower) {
    const migrated = await c.env.DB.prepare(
      'UPDATE emails SET handle = ? WHERE handle = ?'
    ).bind(handle, walletLower).run();
    migratedCount = migrated.meta?.changes || 0;
  }

  // Count pre-stored emails (now under the correct handle)
  const pendingResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM emails WHERE handle = ?'
  ).bind(handle).first<{ count: number }>();

  // 建構回應
  const response: Record<string, any> = {
    success: true,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet: auth.wallet,
    basename: resolvedBasename,
    source,
    token: newToken,
    pending_emails: pendingResult?.count || 0,
    migrated_emails: migratedCount,
  };

  // 如果用 0x handle 註冊且有 Basename NFT → 引導升級
  if (source === 'address') {
    const { has_basename_nft } = await resolveHandle(auth.wallet as Address);
    if (has_basename_nft) {
      response.upgrade_hint = {
        message: 'You have a Basename NFT! Upgrade your handle for a shorter email address.',
        method: 'PUT',
        url: '/api/register/upgrade',
        body: { basename: 'yourname.base.eth' },
        note: 'Pass your Basename to verify ownership and upgrade. Or use auto_basename:true + basename_name to buy a new one.',
      };
    } else {
      response.upgrade_hint = {
        message: 'Want a shorter email like alice@basemail.ai instead of 0x...@basemail.ai?',
        options: [
          {
            action: 'buy_basename',
            method: 'PUT',
            url: '/api/register/upgrade',
            body: { auto_basename: true, basename_name: 'desiredname' },
            note: 'We buy the Basename for you on-chain. Check price first: GET /api/register/price/:name',
          },
          {
            action: 'buy_yourself',
            url: 'https://www.base.org/names',
            note: 'Buy a Basename yourself, then upgrade: PUT /api/register/upgrade { basename: "yourname.base.eth" }',
          },
        ],
      };
    }
  }

  return c.json(response, 201);
});

/**
 * PUT /api/register/upgrade
 * Upgrade 0x handle → Basename handle（已註冊用戶偵測到 Basename 後升級）
 */
registerRoutes.put('/upgrade', authMiddleware(), async (c) => {
  try {
  const auth = c.get('auth');
  const body = await c.req.json<{
    basename?: string;        // e.g. "juchunko.base.eth" — from frontend
    auto_basename?: boolean;  // true = buy a Basename on-chain (worker pays)
    basename_name?: string;   // desired name (required if auto_basename)
  }>().catch(() => ({}));

  // 確認帳號存在且目前是 0x handle
  const account = await c.env.DB.prepare(
    'SELECT handle, basename FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first<{ handle: string; basename: string | null }>();

  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  if (!/^0x/i.test(account.handle)) {
    return c.json({ error: 'Account already has a Basename handle', handle: account.handle }, 400);
  }

  let basenames: string | null = null;
  let newHandle: string;

  if (body.auto_basename) {
    // ── Path A: Buy a Basename on-chain (for AI agents) ──
    if (!c.env.WALLET_PRIVATE_KEY) {
      return c.json({ error: 'Basename auto-registration is not configured' }, 503);
    }

    const name = body.basename_name;
    if (!name || !isValidBasename(name)) {
      return c.json({ error: 'basename_name is required (3-32 chars, a-z, 0-9, -)' }, 400);
    }

    const available = await isBasenameAvailable(name);
    if (!available) {
      return c.json({ error: `Basename "${name}.base.eth" is not available` }, 409);
    }

    try {
      const result = await registerBasename(
        name,
        auth.wallet as Address,
        c.env.WALLET_PRIVATE_KEY as Hex,
        1,
      );
      basenames = result.fullName;
      newHandle = name;
    } catch (e: any) {
      return c.json({ error: `Basename registration failed: ${e.message}` }, 500);
    }
  } else {
    // ── Path B: User already owns a Basename (existing logic) ──
    // First try reverse resolution
    const resolved = await resolveHandle(auth.wallet as Address);
    if (resolved.basename && resolved.source === 'basename') {
      basenames = resolved.basename;
      newHandle = resolved.handle;
    } else if (body.basename && body.basename.endsWith('.base.eth')) {
      // Frontend provided the basename — verify on-chain ownership
      const ownership = await verifyBasenameOwnership(body.basename, auth.wallet);
      if (!ownership.valid) {
        return c.json({ error: ownership.error }, 403);
      }
      basenames = body.basename;
      newHandle = ownership.name;
    } else {
      return c.json({ error: 'No Basename found for this wallet. Get one at https://www.base.org/names' }, 404);
    }
  }

  const oldHandle = account.handle;

  // 檢查新 handle 是否已被占用
  const existing = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(newHandle).first();

  if (existing) {
    return c.json({ error: 'This Basename handle is already registered by another wallet' }, 409);
  }

  // 更新帳號 handle + 遷移信件（batch 以延遲 FK 檢查）
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    c.env.DB.prepare(
      'UPDATE accounts SET handle = ?, basename = ? WHERE wallet = ?'
    ).bind(newHandle, basenames, auth.wallet),
    c.env.DB.prepare(
      'UPDATE emails SET handle = ? WHERE handle = ?'
    ).bind(newHandle, oldHandle),
  ]);
  const migratedCount = batchResults[2]?.meta?.changes || 0;

  // 發新 token
  const secret = c.env.JWT_SECRET!;
  const newToken = await createToken({ wallet: auth.wallet, handle: newHandle }, secret);

  return c.json({
    success: true,
    email: `${newHandle}@${c.env.DOMAIN}`,
    handle: newHandle,
    old_handle: oldHandle,
    basename: basenames,
    token: newToken,
    migrated_emails: migratedCount,
  });
  } catch (e: any) {
    console.log('[upgrade] Error:', e.message, e.stack);
    return c.json({ error: `Upgrade error: ${e.message}` }, 500);
  }
});

/**
 * GET /api/register/check/:address
 * Check what email a wallet address would get
 */
registerRoutes.get('/check/:address', async (c) => {
  const address = c.req.param('address');

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }

  const resolved = await resolveHandle(address.toLowerCase() as Address);

  // Check if already registered
  const existing = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE wallet = ? OR handle = ?'
  ).bind(address.toLowerCase(), resolved.handle).first();

  const response: Record<string, any> = {
    wallet: address.toLowerCase(),
    handle: resolved.handle,
    email: `${resolved.handle}@${c.env.DOMAIN}`,
    basename: resolved.basename,
    source: resolved.source,
    registered: !!existing,
    has_basename_nft: resolved.has_basename_nft || false,
  };

  // AI Agent 指引：有 Basename NFT 但反查失敗
  if (resolved.has_basename_nft && !resolved.basename) {
    response.next_steps = {
      issue: 'You own a Basename NFT but reverse resolution failed (primary name not set on-chain).',
      options: [
        {
          action: 'provide_basename',
          description: 'Pass your Basename directly when registering via agent-register.',
          method: 'POST',
          url: '/api/auth/agent-register',
          body: { address: '0x...', signature: '0x...', message: '...', basename: 'yourname.base.eth' },
        },
        {
          action: 'set_primary_name',
          description: 'Set your primary name on-chain so reverse resolution works automatically.',
          url: 'https://www.base.org/names',
        },
      ],
    };
  }

  return c.json(response);
});

/**
 * GET /api/register/price/:name
 * Query Basename registration price
 */
registerRoutes.get('/price/:name', async (c) => {
  const name = c.req.param('name');

  if (!isValidBasename(name)) {
    return c.json({ error: 'Invalid name format' }, 400);
  }

  try {
    const available = await isBasenameAvailable(name);
    if (!available) {
      return c.json({
        name,
        basename: `${name}.base.eth`,
        available: false,
        price: null,
      });
    }

    const priceWei = await getBasenamePrice(name);
    return c.json({
      name,
      basename: `${name}.base.eth`,
      available: true,
      price_wei: priceWei.toString(),
      price_eth: formatEther(priceWei),
    });
  } catch (e: any) {
    return c.json({ error: `Price query failed: ${e.message}` }, 500);
  }
});

function isValidBasename(name: string): boolean {
  if (name.length < 3 || name.length > 32) return false;
  return /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(name);
}
