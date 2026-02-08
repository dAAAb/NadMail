import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware, createToken } from '../auth';
import { createToken as createNadFunToken } from '../nadfun';

export const registerRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/register
 * Register a @nadmail.ai email + auto-create meme coin on nad.fun.
 *
 * Body: { handle: "alice" }
 * Auth: Bearer JWT (from SIWE verify)
 */
registerRoutes.post('/', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ handle?: string }>().catch(() => ({}));

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

  // Determine handle
  const handle = body.handle?.toLowerCase() || auth.wallet.toLowerCase().slice(0, 10);

  if (!isValidHandle(handle)) {
    return c.json({ error: 'Invalid handle format (3-20 chars, a-z, 0-9, _ only)' }, 400);
  }

  // Check if handle is already taken
  const existing = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(handle).first();

  if (existing) {
    return c.json({ error: 'This handle is already taken' }, 409);
  }

  // Create account
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, created_at, tier)
     VALUES (?, ?, ?, 'free')`
  ).bind(handle, auth.wallet, Math.floor(Date.now() / 1000)).run();

  // Issue JWT with handle
  const secret = c.env.JWT_SECRET!;
  const newToken = await createToken({ wallet: auth.wallet, handle }, secret);

  // Migrate pre-stored emails from wallet handle to new handle
  const walletLower = auth.wallet.toLowerCase();
  let migratedCount = 0;
  if (handle !== walletLower) {
    const migrated = await c.env.DB.prepare(
      'UPDATE emails SET handle = ? WHERE handle = ?'
    ).bind(handle, walletLower).run();
    migratedCount = migrated.meta?.changes || 0;
  }

  // Async token creation on nad.fun (don't block registration)
  let tokenAddress: string | null = null;
  let tokenSymbol: string | null = null;
  let tokenCreateTx: string | null = null;

  try {
    const result = await createNadFunToken(handle, c.env);
    tokenAddress = result.tokenAddress;
    tokenSymbol = handle.toUpperCase();
    tokenCreateTx = result.tx;

    // Update account with token info
    await c.env.DB.prepare(
      'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
    ).bind(tokenAddress, tokenSymbol, tokenCreateTx, handle).run();
  } catch (e: any) {
    // Token creation failed — account still works, can retry later
    console.log(`[register] Token creation failed for ${handle}: ${e.message}`);
  }

  return c.json({
    success: true,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet: auth.wallet,
    token_address: tokenAddress,
    token_symbol: tokenSymbol,
    token_create_tx: tokenCreateTx,
    token: newToken,
    migrated_emails: migratedCount,
  }, 201);
});

/**
 * POST /api/register/retry-token
 * Retry token creation for accounts where it failed
 */
registerRoutes.post('/retry-token', authMiddleware(), async (c) => {
  const auth = c.get('auth');

  const account = await c.env.DB.prepare(
    'SELECT handle, token_address FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first<{ handle: string; token_address: string | null }>();

  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  if (account.token_address) {
    return c.json({ error: 'Token already exists', token_address: account.token_address }, 400);
  }

  try {
    const result = await createNadFunToken(account.handle, c.env);
    const tokenSymbol = account.handle.toUpperCase();

    await c.env.DB.prepare(
      'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
    ).bind(result.tokenAddress, tokenSymbol, result.tx, account.handle).run();

    return c.json({
      success: true,
      token_address: result.tokenAddress,
      token_symbol: tokenSymbol,
      token_create_tx: result.tx,
    });
  } catch (e: any) {
    return c.json({ error: `Token creation failed: ${e.message}` }, 500);
  }
});

/**
 * GET /api/register/check/:address
 * Check what email a wallet address would get (public)
 */
registerRoutes.get('/check/:address', async (c) => {
  const address = c.req.param('address');

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }

  const wallet = address.toLowerCase();
  const existing = await c.env.DB.prepare(
    'SELECT handle, token_address, token_symbol FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; token_address: string | null; token_symbol: string | null }>();

  if (existing) {
    return c.json({
      wallet,
      handle: existing.handle,
      email: `${existing.handle}@${c.env.DOMAIN}`,
      registered: true,
      token_address: existing.token_address,
      token_symbol: existing.token_symbol,
    });
  }

  return c.json({
    wallet,
    handle: null,
    email: null,
    registered: false,
    hint: 'Call POST /api/auth/agent-register to register',
  });
});

function isValidHandle(handle: string): boolean {
  if (handle.length < 3 || handle.length > 20) return false;
  return /^[a-z0-9][a-z0-9_]*[a-z0-9]$/.test(handle) || (handle.length === 3 && /^[a-z0-9]{3}$/.test(handle));
}
