import { Hono } from 'hono';
import { Env } from '../types';
import { generateNonce, verifySiwe, createToken, buildSiweMessage } from '../auth';
import { createToken as createNadFunToken, distributeInitialTokens } from '../nadfun';
import { transferNadName } from '../nns-transfer';

const SIWE_ERROR_MESSAGES: Record<string, string> = {
  no_nonce_in_message: 'SIWE message is malformed — no nonce found. Use the exact message returned by POST /api/auth/start.',
  nonce_expired: 'Nonce has expired (5 min TTL) or was already used. Call POST /api/auth/start again for a fresh nonce.',
  signature_invalid: 'Signature verification failed. Ensure you sign the exact message string with the correct private key (personal_sign / EIP-191).',
};

export const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/auth/start
 * Get nonce + SIWE message in one call
 * Body: { address: "0x..." }
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
 * Verify + auto-register + create meme coin in one call
 * Body: { address: "0x...", signature: "0x...", message: "...", handle?: "alice" }
 */
authRoutes.post('/agent-register', async (c) => {
  const { address, signature, message, handle: requestedHandle } = await c.req.json<{
    address: string;
    signature: string;
    message: string;
    handle?: string;
  }>();

  if (!address || !signature || !message) {
    return c.json({
      error: 'address, signature, and message are required',
      hint: 'Step 1: POST /api/auth/start { address } → get message. Step 2: Sign it. Step 3: Submit here with optional "handle".',
    }, 400);
  }

  // Verify SIWE signature
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
    'SELECT handle, token_address, token_symbol, tier FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; token_address: string | null; token_symbol: string | null; tier: string }>();

  if (existingAccount) {
    const token = await createToken({ wallet, handle: existingAccount.handle }, secret);
    return c.json({
      token,
      email: `${existingAccount.handle}@${c.env.DOMAIN}`,
      handle: existingAccount.handle,
      wallet,
      token_address: existingAccount.token_address,
      token_symbol: existingAccount.token_symbol,
      tier: existingAccount.tier || 'free',
      registered: true,
      new_account: false,
    });
  }

  // Not registered — auto-register
  let handle: string;
  let nadName: string | null = null;
  let nftTransferTx: string | null = null;

  if (requestedHandle) {
    handle = requestedHandle.toLowerCase().trim();
    if (!isValidHandle(handle)) {
      return c.json({ error: 'Invalid handle format (3-20 chars, a-z, 0-9, _ only)' }, 400);
    }

    // Must be a free .nad name
    const freeName = await c.env.DB.prepare(
      'SELECT name, claimed_by FROM free_nad_names WHERE name = ?'
    ).bind(handle).first<{ name: string; claimed_by: string | null }>();

    if (!freeName) {
      return c.json({ error: 'This name is not available for claiming' }, 400);
    }
    if (freeName.claimed_by !== null) {
      return c.json({ error: 'This name has already been claimed' }, 409);
    }

    nadName = `${handle}.nad`;
  } else {
    // Progressive 0x handle: try 0x+8hex, then 0x+10hex, 0x+12hex...
    handle = await resolveUniqueWalletHandle(wallet, c.env.DB);
  }

  // Check handle uniqueness in accounts
  const handleTaken = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(handle).first();
  if (handleTaken) {
    return c.json({ error: 'This handle is already taken' }, 409);
  }

  // Create account first (free_nad_names.claimed_by has FK to accounts.wallet)
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, nad_name, created_at, tier)
     VALUES (?, ?, ?, ?, 'free')`
  ).bind(handle, wallet, nadName, Math.floor(Date.now() / 1000)).run();

  // Claim free name + transfer NFT (after account exists for FK constraint)
  if (requestedHandle) {
    await c.env.DB.prepare(
      'UPDATE free_nad_names SET claimed_by = ?, claimed_at = ? WHERE name = ? AND claimed_by IS NULL'
    ).bind(wallet, Math.floor(Date.now() / 1000), handle).run();

    try {
      nftTransferTx = await transferNadName(handle, wallet, c.env);
      console.log(`[agent-register] NFT ${handle}.nad transferred to ${wallet}: ${nftTransferTx}`);
    } catch (e: any) {
      console.log(`[agent-register] NFT transfer failed for ${handle}: ${e.message}`);
    }
  }

  // Migrate pre-stored emails
  let migratedCount = 0;
  if (handle !== wallet) {
    const migrated = await c.env.DB.prepare(
      'UPDATE emails SET handle = ? WHERE handle = ?'
    ).bind(handle, wallet).run();
    migratedCount = migrated.meta?.changes || 0;
  }

  // Try to create token on nad.fun
  let tokenAddress: string | null = null;
  let tokenSymbol: string | null = null;

  try {
    const tokenResult = await createNadFunToken(handle, wallet, c.env);
    tokenAddress = tokenResult.tokenAddress;
    tokenSymbol = /^0x[a-f0-9]{40}$/.test(handle)
      ? handle.slice(0, 10).toUpperCase()
      : handle.toUpperCase();

    await c.env.DB.prepare(
      'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
    ).bind(tokenAddress, tokenSymbol, tokenResult.tx, handle).run();

    // Distribute initial tokens in background (50/50 creator + platform)
    c.executionCtx.waitUntil(
      distributeInitialTokens(tokenResult.tokenAddress, wallet, c.env)
    );
  } catch (e: any) {
    console.log(`[agent-register] Token creation failed for ${handle}: ${e.message}`);
  }

  const token = await createToken({ wallet, handle }, secret);

  // Count pending emails
  const pendingResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM emails WHERE handle = ?'
  ).bind(handle).first<{ count: number }>();

  return c.json({
    token,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet,
    nad_name: nadName,
    nft_transfer_tx: nftTransferTx,
    token_address: tokenAddress,
    token_symbol: tokenSymbol,
    tier: 'free',
    registered: true,
    new_account: true,
    pending_emails: pendingResult?.count || 0,
    migrated_emails: migratedCount,
  }, 201);
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
 * Verify SIWE signature, return JWT
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

  const account = await c.env.DB.prepare(
    'SELECT handle, token_address, token_symbol, tier FROM accounts WHERE wallet = ?'
  ).bind(wallet).first<{ handle: string; token_address: string | null; token_symbol: string | null; tier: string }>();

  const secret = c.env.JWT_SECRET!;
  const token = await createToken(
    { wallet, handle: account?.handle || '' },
    secret,
  );

  return c.json({
    token,
    wallet,
    handle: account?.handle || null,
    registered: !!account,
    token_address: account?.token_address || null,
    token_symbol: account?.token_symbol || null,
    tier: account?.tier || 'free',
  });
});

function isValidHandle(handle: string): boolean {
  if (handle.length < 3 || handle.length > 20) return false;
  return /^[a-z0-9][a-z0-9_]*[a-z0-9]$/.test(handle) || (handle.length === 3 && /^[a-z0-9]{3}$/.test(handle));
}

/**
 * Progressive 0x handle resolution.
 * Try 0x+8hex, then 0x+10hex, 0x+12hex... until unique.
 * Token name = handle@nadmail.ai (always ≤ 32 chars since handle ≤ 21 chars)
 */
async function resolveUniqueWalletHandle(wallet: string, db: any): Promise<string> {
  const w = wallet.toLowerCase();
  // Start at 10 chars (0x + 8 hex), step by 2 hex chars
  for (let len = 10; len <= 42; len += 2) {
    const candidate = w.slice(0, len);
    const taken = await db.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(candidate).first();
    if (!taken) return candidate;
  }
  // Full address as ultimate fallback (guaranteed unique by wallet UNIQUE constraint)
  return w;
}
