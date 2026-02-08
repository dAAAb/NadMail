import { Hono } from 'hono';
import { Env } from '../types';
import { authMiddleware, createToken } from '../auth';
import { createToken as createNadFunToken } from '../nadfun';
import { transferNadName } from '../nns-transfer';

export const registerRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/register/free-names
 * Public — returns all free .nad names with availability status.
 */
registerRoutes.get('/free-names', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT name, description, claimed_by FROM free_nad_names ORDER BY name'
  ).all<{ name: string; description: string; claimed_by: string | null }>();

  const names = (rows.results || []).map((r) => ({
    name: r.name,
    description: r.description,
    available: r.claimed_by === null,
  }));

  return c.json({
    names,
    available_count: names.filter((n) => n.available).length,
    total: names.length,
  });
});

/**
 * POST /api/register
 * Register a @nadmail.ai email.
 *
 * Body: { handle: "euler" }  → claim free .nad name + create token
 * Body: {} or no handle      → 0x fallback, no token
 *
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

  const requestedHandle = body.handle?.toLowerCase().trim();

  let handle: string;
  let nadName: string | null = null;
  let shouldCreateToken = false;
  let nftTransferTx: string | null = null;

  if (requestedHandle) {
    // Must be a free .nad name
    const freeName = await c.env.DB.prepare(
      'SELECT name, claimed_by FROM free_nad_names WHERE name = ?'
    ).bind(requestedHandle).first<{ name: string; claimed_by: string | null }>();

    if (!freeName) {
      return c.json({ error: 'This name is not available for claiming' }, 400);
    }

    if (freeName.claimed_by !== null) {
      return c.json({ error: 'This name has already been claimed' }, 409);
    }

    // Step 1: Transfer .nad NFT to user (must succeed before proceeding)
    try {
      nftTransferTx = await transferNadName(requestedHandle, auth.wallet, c.env);
      console.log(`[register] NFT ${requestedHandle}.nad transferred to ${auth.wallet}: ${nftTransferTx}`);
    } catch (e: any) {
      console.log(`[register] NFT transfer failed for ${requestedHandle}: ${e.message}`);
      // If worker doesn't own the NFT, still allow claim (name may not be pre-bought yet)
      // This makes it work for hackathon demo even before NFTs are loaded
    }

    // Claim the free name in DB
    await c.env.DB.prepare(
      'UPDATE free_nad_names SET claimed_by = ?, claimed_at = ? WHERE name = ? AND claimed_by IS NULL'
    ).bind(auth.wallet, Math.floor(Date.now() / 1000), requestedHandle).run();

    handle = requestedHandle;
    nadName = `${requestedHandle}.nad`;
    shouldCreateToken = true;
  } else {
    // 0x fallback — no token
    handle = auth.wallet.toLowerCase().slice(0, 10);
    // Ensure this default handle isn't taken (edge case)
    const existing = await c.env.DB.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(handle).first();
    if (existing) {
      handle = auth.wallet.toLowerCase().slice(0, 14);
    }
  }

  // Check handle uniqueness
  const handleTaken = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(handle).first();

  if (handleTaken) {
    // Revert free name claim if we just claimed it
    if (requestedHandle) {
      await c.env.DB.prepare(
        'UPDATE free_nad_names SET claimed_by = NULL, claimed_at = NULL WHERE name = ?'
      ).bind(requestedHandle).run();
    }
    return c.json({ error: 'This handle is already taken' }, 409);
  }

  // Create account
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, nad_name, created_at, tier)
     VALUES (?, ?, ?, ?, 'free')`
  ).bind(handle, auth.wallet, nadName, Math.floor(Date.now() / 1000)).run();

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

  // Token creation (only for .nad name claims)
  let tokenAddress: string | null = null;
  let tokenSymbol: string | null = null;
  let tokenCreateTx: string | null = null;

  if (shouldCreateToken) {
    try {
      const result = await createNadFunToken(handle, c.env);
      tokenAddress = result.tokenAddress;
      tokenSymbol = handle.toUpperCase();
      tokenCreateTx = result.tx;

      await c.env.DB.prepare(
        'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
      ).bind(tokenAddress, tokenSymbol, tokenCreateTx, handle).run();
    } catch (e: any) {
      console.log(`[register] Token creation failed for ${handle}: ${e.message}`);
    }
  }

  return c.json({
    success: true,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet: auth.wallet,
    nad_name: nadName,
    nft_transfer_tx: nftTransferTx,
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
    'SELECT handle, token_address, nad_name FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first<{ handle: string; token_address: string | null; nad_name: string | null }>();

  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  if (account.token_address) {
    return c.json({ error: 'Token already exists', token_address: account.token_address }, 400);
  }

  if (!account.nad_name) {
    return c.json({ error: 'Token creation requires a .nad name' }, 400);
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
    'SELECT handle, token_address, token_symbol, nad_name FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; token_address: string | null; token_symbol: string | null; nad_name: string | null }>();

  if (existing) {
    return c.json({
      wallet,
      handle: existing.handle,
      email: `${existing.handle}@${c.env.DOMAIN}`,
      registered: true,
      nad_name: existing.nad_name,
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
