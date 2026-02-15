import { Hono } from 'hono';
import { createPublicClient, http, formatEther, type Hex } from 'viem';
import { Env } from '../types';
import { authMiddleware, createToken } from '../auth';
import { createToken as createNadFunToken, distributeInitialTokens } from '../nadfun';
import { transferNadName } from '../nns-transfer';
import { getNadNamesForWallet } from '../nns-lookup';
import { getNnsPriceFromFrontend } from '../nns-price-scraper';
import { executeNnsPurchase, getDiscountProofs, encodeReferralCode } from '../nns-purchase';

const PRICE_ORACLE_V2 = '0xdF0e18bb6d8c5385d285C3c67919E99c0dce020d' as const;
const NNS_REGISTRAR = '0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb' as const;

const priceOracleAbi = [
  {
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'token', type: 'address' },
    ],
    name: 'getRegisteringPriceInToken',
    outputs: [{
      components: [
        { name: 'base', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'decimals', type: 'uint8' },
      ],
      type: 'tuple',
    }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
] as const;

const registrarAbi = [
  {
    inputs: [{ name: 'name', type: 'string' }],
    name: 'available',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
  {
    inputs: [],
    name: 'getActiveDiscounts',
    outputs: [{
      components: [
        { name: 'active', type: 'bool' },
        { name: 'discountVerifier', type: 'address' },
        { name: 'key', type: 'bytes32' },
        { name: 'discountPercent', type: 'uint256' },
        { name: 'description', type: 'string' },
      ],
      type: 'tuple[]',
    }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
] as const;

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

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
 * GET /api/register/nad-names/:address
 * Public — returns .nad names owned by a wallet, with availability status.
 */
registerRoutes.get('/nad-names/:address', async (c) => {
  const address = c.req.param('address');

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ error: 'Invalid wallet address' }, 400);
  }

  const wallet = address.toLowerCase();
  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';

  let nadNames: string[];
  try {
    nadNames = await getNadNamesForWallet(wallet, rpcUrl);
  } catch (e: any) {
    console.log(`[register] NNS lookup failed for ${wallet}: ${e.message}`);
    return c.json({ wallet, names: [], error: 'Failed to query NNS contract' });
  }

  if (nadNames.length === 0) {
    return c.json({ wallet, names: [] });
  }

  // Check DB availability for each name
  const namesWithStatus = await Promise.all(
    nadNames.map(async (name) => {
      const existing = await c.env.DB.prepare(
        'SELECT handle FROM accounts WHERE handle = ?'
      ).bind(name.toLowerCase()).first();
      return {
        name: name.toLowerCase(),
        available: !existing,
      };
    }),
  );

  return c.json({
    wallet,
    names: namesWithStatus,
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

  let isFreeName = false;
  let isOwnedNad = false;

  if (requestedHandle) {
    // First check free .nad name pool
    const freeName = await c.env.DB.prepare(
      'SELECT name, claimed_by FROM free_nad_names WHERE name = ?'
    ).bind(requestedHandle).first<{ name: string; claimed_by: string | null }>();

    if (freeName) {
      if (freeName.claimed_by !== null) {
        return c.json({ error: 'This name has already been claimed' }, 409);
      }
      isFreeName = true;
    } else {
      // Not in free pool — check if user owns this .nad name on-chain
      const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
      try {
        const ownedNames = await getNadNamesForWallet(auth.wallet, rpcUrl);
        const ownsName = ownedNames.some(
          (n) => n.toLowerCase() === requestedHandle,
        );
        if (!ownsName) {
          return c.json({
            error: 'You do not own this .nad name',
            hint: 'You can claim a free name, use your own .nad name, or register with 0x address',
          }, 403);
        }
        isOwnedNad = true;
      } catch (e: any) {
        console.log(`[register] NNS verification failed: ${e.message}`);
        return c.json({ error: 'Failed to verify .nad name ownership' }, 500);
      }
    }

    handle = requestedHandle;
    nadName = `${requestedHandle}.nad`;
    shouldCreateToken = true;
  } else {
    // Progressive 0x handle: try 0x+8hex, then 0x+10hex, 0x+12hex...
    handle = await resolveUniqueWalletHandle(auth.wallet, c.env.DB);
  }

  // Check handle uniqueness (for .nad names — 0x handles are already unique from resolver)
  if (requestedHandle) {
    const handleTaken = await c.env.DB.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(handle).first();

    if (handleTaken) {
      return c.json({ error: 'This handle is already taken' }, 409);
    }
  }

  // Create account first (free_nad_names.claimed_by has FK to accounts.wallet)
  await c.env.DB.prepare(
    `INSERT INTO accounts (handle, wallet, nad_name, created_at, tier)
     VALUES (?, ?, ?, ?, 'free')`
  ).bind(handle, auth.wallet, nadName, Math.floor(Date.now() / 1000)).run();

  // Claim free name + transfer NFT (only for free pool names — user-owned .nad names already have the NFT)
  if (isFreeName) {
    await c.env.DB.prepare(
      'UPDATE free_nad_names SET claimed_by = ?, claimed_at = ? WHERE name = ? AND claimed_by IS NULL'
    ).bind(auth.wallet, Math.floor(Date.now() / 1000), requestedHandle).run();

    try {
      nftTransferTx = await transferNadName(requestedHandle, auth.wallet, c.env);
      console.log(`[register] NFT ${requestedHandle}.nad transferred to ${auth.wallet}: ${nftTransferTx}`);
    } catch (e: any) {
      console.log(`[register] NFT transfer failed for ${requestedHandle}: ${e.message}`);
    }
  }

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
      const result = await createNadFunToken(handle, auth.wallet, c.env);
      tokenAddress = result.tokenAddress;
      tokenSymbol = handle.slice(0, 10).toUpperCase();
      tokenCreateTx = result.tx;

      // Distribute initial tokens in background (50/50 creator + platform)
      c.executionCtx.waitUntil(
        distributeInitialTokens(result.tokenAddress, auth.wallet, c.env)
      );

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
    const result = await createNadFunToken(account.handle, auth.wallet, c.env);
    const tokenSymbol = account.handle.slice(0, 10).toUpperCase();

    await c.env.DB.prepare(
      'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
    ).bind(result.tokenAddress, tokenSymbol, result.tx, account.handle).run();

    // Distribute initial tokens in background
    c.executionCtx.waitUntil(
      distributeInitialTokens(result.tokenAddress, auth.wallet, c.env)
    );

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
 * POST /api/register/upgrade-handle
 * Upgrade a 0x handle to a .nad name handle.
 * Requires on-chain ownership verification.
 *
 * Body: { new_handle: "alice" }
 */
registerRoutes.post('/upgrade-handle', authMiddleware(), async (c) => {
  const auth = c.get('auth');

  const body = await c.req.json<{ new_handle: string }>().catch(() => ({ new_handle: '' }));
  const newHandle = body.new_handle?.toLowerCase().trim();

  if (!newHandle || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(newHandle)) {
    return c.json({ error: 'Invalid handle format' }, 400);
  }

  // Get current account
  const account = await c.env.DB.prepare(
    'SELECT handle, nad_name, token_address FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first<{ handle: string; nad_name: string | null; token_address: string | null }>();

  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  const oldHandle = account.handle;

  // Must be upgrading from a 0x handle
  if (!oldHandle.startsWith('0x')) {
    return c.json({
      error: 'Your account already has a .nad name handle',
      current_handle: oldHandle,
    }, 400);
  }

  // Check the new handle is not already taken
  const handleTaken = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(newHandle).first();

  if (handleTaken) {
    return c.json({ error: 'This handle is already taken' }, 409);
  }

  // Verify on-chain ownership
  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  let ownedNames: string[];
  try {
    ownedNames = await getNadNamesForWallet(auth.wallet, rpcUrl);
  } catch (e: any) {
    console.log(`[upgrade] NNS lookup failed for ${auth.wallet}: ${e.message}`);
    return c.json({ error: 'Failed to verify .nad name ownership' }, 500);
  }

  const ownsName = ownedNames.some((n) => n.toLowerCase() === newHandle);
  if (!ownsName) {
    return c.json({
      error: `You do not own ${newHandle}.nad`,
      owned_names: ownedNames.map((n) => n.toLowerCase()),
    }, 403);
  }

  // ── Cascade update handle across all tables ──
  const now = Math.floor(Date.now() / 1000);

  // 1. Update accounts (set new handle, nad_name, previous_handle)
  await c.env.DB.prepare(
    'UPDATE accounts SET handle = ?, nad_name = ?, previous_handle = ? WHERE wallet = ?'
  ).bind(newHandle, `${newHandle}.nad`, oldHandle, auth.wallet).run();

  // 2. Update emails
  await c.env.DB.prepare(
    'UPDATE emails SET handle = ? WHERE handle = ?'
  ).bind(newHandle, oldHandle).run();

  // 3. Update daily_email_counts
  await c.env.DB.prepare(
    'UPDATE daily_email_counts SET handle = ? WHERE handle = ?'
  ).bind(newHandle, oldHandle).run();

  // 4. Update credit_transactions
  await c.env.DB.prepare(
    'UPDATE credit_transactions SET handle = ? WHERE handle = ?'
  ).bind(newHandle, oldHandle).run();

  // 5. Update daily_emobuy_totals
  await c.env.DB.prepare(
    'UPDATE daily_emobuy_totals SET handle = ? WHERE handle = ?'
  ).bind(newHandle, oldHandle).run();

  // ── Create nad.fun token ──
  let tokenAddress: string | null = null;
  let tokenSymbol: string | null = null;
  let tokenCreateTx: string | null = null;

  if (!account.token_address) {
    try {
      const result = await createNadFunToken(newHandle, auth.wallet, c.env);
      tokenAddress = result.tokenAddress;
      tokenSymbol = newHandle.slice(0, 10).toUpperCase();
      tokenCreateTx = result.tx;

      c.executionCtx.waitUntil(
        distributeInitialTokens(result.tokenAddress, auth.wallet, c.env),
      );

      await c.env.DB.prepare(
        'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
      ).bind(tokenAddress, tokenSymbol, tokenCreateTx, newHandle).run();
    } catch (e: any) {
      console.log(`[upgrade] Token creation failed for ${newHandle}: ${e.message}`);
    }
  }

  // ── Issue new JWT ──
  const secret = c.env.JWT_SECRET!;
  const newToken = await createToken({ wallet: auth.wallet, handle: newHandle }, secret);

  console.log(`[upgrade] ${oldHandle} → ${newHandle} for wallet ${auth.wallet}`);

  return c.json({
    success: true,
    old_handle: oldHandle,
    new_handle: newHandle,
    email: `${newHandle}@${c.env.DOMAIN}`,
    nad_name: `${newHandle}.nad`,
    token: newToken,
    token_address: tokenAddress || account.token_address,
    token_symbol: tokenSymbol || null,
    token_create_tx: tokenCreateTx,
  });
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
    // For registered 0x handle users, check if they have .nad names available
    let upgrade_available = false;
    let owned_nad_names: string[] = [];

    if (/^0x/i.test(existing.handle)) {
      try {
        const names = await getNadNamesForWallet(wallet, c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz');
        owned_nad_names = names.map(n => n.toLowerCase());
        upgrade_available = owned_nad_names.length > 0;
      } catch { /* non-critical */ }
    }

    return c.json({
      wallet,
      handle: existing.handle,
      email: `${existing.handle}@${c.env.DOMAIN}`,
      registered: true,
      nad_name: existing.nad_name,
      token_address: existing.token_address,
      token_symbol: existing.token_symbol,
      upgrade_available,
      owned_nad_names: upgrade_available ? owned_nad_names : undefined,
    });
  }

  // Not registered — check on-chain for .nad names
  let owned_nad_names: string[] = [];
  try {
    const names = await getNadNamesForWallet(wallet, c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz');
    owned_nad_names = names.map(n => n.toLowerCase());
  } catch { /* non-critical */ }

  return c.json({
    wallet,
    handle: null,
    email: null,
    registered: false,
    owned_nad_names,
    has_nad_name: owned_nad_names.length > 0,
    hint: owned_nad_names.length > 0
      ? `You own ${owned_nad_names[0]}.nad! Register with POST /api/auth/agent-register { "handle": "${owned_nad_names[0]}" }`
      : 'Call POST /api/auth/agent-register to register',
  });
});

/**
 * GET /api/register/nad-name-price/:name
 * Public — query NNS PriceOracleV2 for real-time .nad name pricing.
 */
registerRoutes.get('/nad-name-price/:name', async (c) => {
  const name = c.req.param('name').toLowerCase().replace(/\.nad$/, '');
  const buyerAddress = c.req.query('buyer'); // optional: check discounts for this buyer

  if (!name || name.length < 3 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return c.json({ error: 'Invalid .nad name (3+ chars, alphanumeric + hyphens)' }, 400);
  }

  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  const client = createPublicClient({
    chain: monad,
    transport: http(rpcUrl),
  });

  const SERVICE_FEE_PERCENT = parseInt(c.env.SERVICE_FEE_PERCENT || '15', 10);
  const FEE_RECIPIENT = c.env.FEE_RECIPIENT || c.env.WALLET_ADDRESS;
  const NNS_REFERRER = (c.env as any).NNS_REFERRER || '0x7e0F24854c7189C9B709132fEb6e953D4EC74424'; // diplomat.nad

  try {
    // Check availability + get price + get active discounts in parallel
    const queries: [Promise<boolean>, Promise<any>, Promise<any>] = [
      client.readContract({
        address: NNS_REGISTRAR,
        abi: registrarAbi,
        functionName: 'available',
        args: [name],
      }),
      client.readContract({
        address: PRICE_ORACLE_V2,
        abi: priceOracleAbi,
        functionName: 'getRegisteringPriceInToken',
        args: [name, '0x0000000000000000000000000000000000000000'],
      }),
      client.readContract({
        address: NNS_REGISTRAR,
        abi: registrarAbi,
        functionName: 'getActiveDiscounts',
        args: [],
      }),
    ];

    const [isAvailable, priceResult, activeDiscounts] = await Promise.all(queries);

    const basePriceWei = priceResult.base as bigint;
    const priceMon = parseFloat(formatEther(basePriceWei));

    // Format active discounts
    const discounts = (activeDiscounts as any[]).map((d: any) => ({
      description: d.description,
      percent: Number(d.discountPercent),
      key: d.key,
      active: d.active,
    }));

    // Find best discount if buyer address provided
    let bestDiscount: { description: string; percent: number; key: string; proof?: string } | null = null;

    if (buyerAddress) {
      try {
        const proofs = await getDiscountProofs(buyerAddress, name);
        for (const proof of proofs) {
          if (proof.validationData === '0x0000000000000000000000000000000000000000000000000000000000000000') continue;
          const matching = discounts.find(d => {
            // Compare discount key (decode bytes32 to string)
            const keyHex = d.key.replace(/0+$/, '');
            const keyStr = Buffer.from(keyHex.replace('0x', ''), 'hex').toString('utf-8').replace(/\0/g, '');
            return keyStr === proof.discountKey;
          });
          if (matching && (!bestDiscount || matching.percent > bestDiscount.percent)) {
            bestDiscount = {
              description: matching.description,
              percent: matching.percent,
              key: matching.key,
              proof: proof.validationData,
            };
          }
        }
      } catch (e: any) {
        console.log(`[nad-name-price] Discount proof lookup failed: ${e.message}`);
      }
    }

    // If no buyer-specific discount, show best available discount
    if (!bestDiscount) {
      const best = discounts.reduce((max, d) => d.percent > max.percent ? d : max, { percent: 0 } as any);
      if (best.percent > 0) {
        bestDiscount = { description: best.description, percent: best.percent, key: best.key };
      }
    }

    const discountPercent = bestDiscount?.percent || 0;
    const discountedPriceWei = basePriceWei - (basePriceWei * BigInt(discountPercent)) / 100n;
    const discountedPriceMon = parseFloat(formatEther(discountedPriceWei));
    const feeWei = (discountedPriceWei * BigInt(SERVICE_FEE_PERCENT)) / 100n;
    const totalWei = discountedPriceWei + feeWei;
    const feeMon = parseFloat(formatEther(feeWei));
    const totalMon = parseFloat(formatEther(totalWei));

    // Also check if already registered in NadMail
    const nadmailTaken = await c.env.DB.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(name).first();

    // Generate referral URL
    const referralUrl = `https://app.nad.domains?rc=${encodeReferralCode(NNS_REFERRER)}`;

    return c.json({
      name,
      nad_name: `${name}.nad`,
      available_nns: isAvailable,
      available_nadmail: !nadmailTaken,

      // Pricing
      price_mon: priceMon,
      price_wei: basePriceWei.toString(),
      discount: bestDiscount ? {
        description: bestDiscount.description,
        percent: bestDiscount.percent,
        buyer_eligible: !!bestDiscount.proof,
      } : null,
      discounted_price_mon: discountedPriceMon,
      discounted_price_wei: discountedPriceWei.toString(),

      // Proxy-buy
      proxy_buy: {
        service_fee_percent: SERVICE_FEE_PERCENT,
        fee_mon: Math.ceil(feeMon * 100) / 100,
        total_mon: Math.ceil(totalMon * 100) / 100,
        total_wei: totalWei.toString(),
        available: isAvailable && !nadmailTaken,
        deposit_address: c.env.WALLET_ADDRESS,
        fee_recipient: FEE_RECIPIENT,
      },

      // Referral (buy directly on nad.domains)
      referral: {
        url: referralUrl,
        commission_percent: 10,
        referrer: 'diplomat.nad',
      },

      // Available discounts
      available_discounts: discounts.filter(d => d.active).map(d => ({
        description: d.description,
        percent: d.percent,
      })),
    });
  } catch (e: any) {
    console.log(`[nad-name-price] Query failed for ${name}: ${e.message}`);
    return c.json({
      name,
      nad_name: `${name}.nad`,
      error: 'Failed to query NNS pricing contract',
      detail: e.message,
      buy_direct_url: 'https://app.nad.domains/',
    }, 500);
  }
});

// ── .nad Name Proxy Purchase ──

const CONVENIENCE_FEE_RATE = 0.15; // 15%
const QUOTE_EXPIRY_SECONDS = 600;  // 10 minutes

/**
 * POST /api/register/buy-nad-name/quote
 * Get a price quote for proxy-purchasing a .nad name.
 *
 * Auth: Bearer token
 * Body: { name: "alice" }
 */
registerRoutes.post('/buy-nad-name/quote', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ name: string }>().catch(() => ({ name: '' }));
  const name = body.name?.toLowerCase().trim().replace(/\.nad$/, '');

  if (!name || name.length < 3 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return c.json({ error: 'Invalid .nad name (3+ chars, alphanumeric + hyphens)' }, 400);
  }

  // Check NadMail availability
  const nadmailTaken = await c.env.DB.prepare(
    'SELECT handle FROM accounts WHERE handle = ?'
  ).bind(name).first();

  if (nadmailTaken) {
    return c.json({ error: `${name} is already registered on NadMail` }, 409);
  }

  // Check for existing active order
  const existingOrder = await c.env.DB.prepare(
    "SELECT id, status FROM proxy_purchases WHERE wallet = ? AND name = ? AND status IN ('pending', 'paid', 'purchasing')"
  ).bind(auth.wallet, name).first<{ id: string; status: string }>();

  if (existingOrder) {
    return c.json({
      error: 'You already have an active order for this name',
      existing_order_id: existingOrder.id,
      status: existingOrder.status,
    }, 409);
  }

  // Query NNS on-chain availability + price
  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  const client = createPublicClient({ chain: monad, transport: http(rpcUrl) });

  let isAvailable: boolean;
  let basePriceWei: bigint;

  try {
    const [avail, priceResult] = await Promise.all([
      client.readContract({
        address: NNS_REGISTRAR,
        abi: registrarAbi,
        functionName: 'available',
        args: [name],
      }),
      client.readContract({
        address: PRICE_ORACLE_V2,
        abi: priceOracleAbi,
        functionName: 'getRegisteringPriceInToken',
        args: [name, '0x0000000000000000000000000000000000000000'],
      }),
    ]);
    isAvailable = avail;
    basePriceWei = priceResult.base;
  } catch (e: any) {
    return c.json({ error: `Failed to query NNS contract: ${e.message}` }, 500);
  }

  if (!isAvailable) {
    return c.json({ error: `${name}.nad is not available on NNS` }, 409);
  }

  // Calculate price with 15% convenience fee (bigint math)
  const feeWei = (basePriceWei * 15n) / 100n;
  const totalWei = basePriceWei + feeWei;

  // Create pending order
  const now = Math.floor(Date.now() / 1000);
  const orderId = `pp-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  await c.env.DB.prepare(
    `INSERT INTO proxy_purchases (id, wallet, name, status, price_wei, fee_wei, total_wei, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(orderId, auth.wallet, name, basePriceWei.toString(), feeWei.toString(), totalWei.toString(), now).run();

  const priceMon = parseFloat(formatEther(basePriceWei));
  const feeMon = parseFloat(formatEther(feeWei));
  const totalMon = parseFloat(formatEther(totalWei));

  return c.json({
    order_id: orderId,
    name,
    nad_name: `${name}.nad`,
    price: {
      base_mon: priceMon,
      base_wei: basePriceWei.toString(),
      fee_percent: CONVENIENCE_FEE_RATE * 100,
      fee_mon: feeMon,
      fee_wei: feeWei.toString(),
      total_mon: totalMon,
      total_wei: totalWei.toString(),
    },
    payment: {
      deposit_address: c.env.WALLET_ADDRESS,
      amount_mon: totalMon,
      amount_wei: totalWei.toString(),
      chain: 'Monad (chainId: 143)',
      currency: 'MON (native)',
      instruction: `Send exactly ${totalMon.toFixed(4)} MON to ${c.env.WALLET_ADDRESS} on Monad chain, then call POST /api/register/buy-nad-name with { "name": "${name}", "tx_hash": "0x..." }`,
    },
    expires_at: now + QUOTE_EXPIRY_SECONDS,
    expires_in_seconds: QUOTE_EXPIRY_SECONDS,
  });
});

/**
 * POST /api/register/buy-nad-name
 * Execute .nad name proxy purchase after payment verification.
 * Auto-upgrades 0x handles.
 *
 * Auth: Bearer token
 * Body: { name: "alice", tx_hash: "0x..." }
 */
registerRoutes.post('/buy-nad-name', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json<{ name: string; tx_hash: string }>().catch(() => ({ name: '', tx_hash: '' }));

  const name = body.name?.toLowerCase().trim().replace(/\.nad$/, '');
  const txHash = body.tx_hash;

  if (!name || !txHash || !txHash.startsWith('0x')) {
    return c.json({ error: 'name and tx_hash are required' }, 400);
  }

  if (name.length < 3 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return c.json({ error: 'Invalid .nad name format' }, 400);
  }

  // ── Check tx_hash not already used ──
  const txUsedInCredits = await c.env.DB.prepare(
    'SELECT id FROM credit_transactions WHERE tx_hash = ?'
  ).bind(txHash).first();

  const txUsedInProxy = await c.env.DB.prepare(
    'SELECT id FROM proxy_purchases WHERE payment_tx = ?'
  ).bind(txHash).first();

  if (txUsedInCredits || txUsedInProxy) {
    return c.json({ error: 'Transaction already used' }, 409);
  }

  // ── Find pending order or create one on the fly ──
  let order = await c.env.DB.prepare(
    "SELECT id, total_wei, price_wei, fee_wei FROM proxy_purchases WHERE wallet = ? AND name = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).bind(auth.wallet, name).first<{ id: string; total_wei: string; price_wei: string; fee_wei: string }>();

  let totalWeiRequired: bigint;
  let priceWei: bigint;
  let feeWei: bigint;
  let orderId: string;

  if (order) {
    totalWeiRequired = BigInt(order.total_wei);
    priceWei = BigInt(order.price_wei);
    feeWei = BigInt(order.fee_wei);
    orderId = order.id;
  } else {
    // No quote — query price on the fly
    const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
    const queryClient = createPublicClient({ chain: monad, transport: http(rpcUrl) });

    try {
      const [isAvailable, priceResult] = await Promise.all([
        queryClient.readContract({
          address: NNS_REGISTRAR,
          abi: registrarAbi,
          functionName: 'available',
          args: [name],
        }),
        queryClient.readContract({
          address: PRICE_ORACLE_V2,
          abi: priceOracleAbi,
          functionName: 'getRegisteringPriceInToken',
          args: [name, '0x0000000000000000000000000000000000000000'],
        }),
      ]);

      if (!isAvailable) {
        return c.json({ error: `${name}.nad is no longer available` }, 409);
      }
      priceWei = priceResult.base;
    } catch (e: any) {
      return c.json({ error: `Failed to query NNS: ${e.message}` }, 500);
    }

    feeWei = (priceWei * 15n) / 100n;
    totalWeiRequired = priceWei + feeWei;
    orderId = `pp-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

    await c.env.DB.prepare(
      `INSERT INTO proxy_purchases (id, wallet, name, status, price_wei, fee_wei, total_wei, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(orderId, auth.wallet, name, priceWei.toString(), feeWei.toString(), totalWeiRequired.toString(), Math.floor(Date.now() / 1000)).run();
  }

  // ── On-chain payment verification (follows credits.ts pattern) ──
  const client = createPublicClient({
    chain: monad,
    transport: http(c.env.MONAD_RPC_URL),
  });

  let tx, receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 15_000 });
    tx = await client.getTransaction({ hash: txHash as Hex });
  } catch {
    return c.json({ error: 'Transaction not found on Monad. Please wait and try again.' }, 404);
  }

  if (!tx || !receipt || receipt.status !== 'success') {
    return c.json({ error: 'Transaction not found or failed on-chain' }, 400);
  }

  const walletAddress = c.env.WALLET_ADDRESS?.toLowerCase();
  if (!walletAddress || tx.to?.toLowerCase() !== walletAddress) {
    return c.json({
      error: 'Transaction recipient is not the NadMail deposit address',
      expected: walletAddress,
    }, 400);
  }

  // Allow 5% tolerance for price fluctuations
  const minAcceptable = (totalWeiRequired * 95n) / 100n;
  if (tx.value < minAcceptable) {
    return c.json({
      error: `Insufficient payment. Required: ${formatEther(totalWeiRequired)} MON, received: ${formatEther(tx.value)} MON`,
      required_wei: totalWeiRequired.toString(),
      sent_wei: tx.value.toString(),
    }, 400);
  }

  // ── Update order → paid ──
  const paidAt = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "UPDATE proxy_purchases SET status = 'paid', payment_tx = ?, paid_at = ? WHERE id = ?"
  ).bind(txHash, paidAt, orderId).run();

  // ── Execute NNS purchase ──
  await c.env.DB.prepare(
    "UPDATE proxy_purchases SET status = 'purchasing' WHERE id = ?"
  ).bind(orderId).run();

  let purchaseResult;
  try {
    purchaseResult = await executeNnsPurchase(name, auth.wallet, priceWei, c.env);
  } catch (e: any) {
    // Purchase failed after payment — mark for refund
    await c.env.DB.prepare(
      "UPDATE proxy_purchases SET status = 'refund_needed', error_message = ? WHERE id = ?"
    ).bind(e.message, orderId).run();

    console.error(`[proxy-purchase] FAILED for ${name} (order ${orderId}): ${e.message}`);

    return c.json({
      error: 'Purchase failed after payment received',
      order_id: orderId,
      status: 'refund_needed',
      detail: e.message,
      refund_guidance: 'Your payment has been recorded. The NadMail team will process a refund. Contact support with your order_id if needed.',
    }, 500);
  }

  // ── Purchase success ──
  const completedAt = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "UPDATE proxy_purchases SET status = 'completed', purchase_tx = ?, completed_at = ? WHERE id = ?"
  ).bind(purchaseResult.txHash, completedAt, orderId).run();

  // ── Auto-upgrade if user has 0x handle ──
  let autoUpgraded = false;
  let newJwt: string | null = null;
  let tokenAddress: string | null = null;
  let tokenSymbol: string | null = null;

  const account = await c.env.DB.prepare(
    'SELECT handle, token_address FROM accounts WHERE wallet = ?'
  ).bind(auth.wallet).first<{ handle: string; token_address: string | null }>();

  if (account && account.handle.startsWith('0x')) {
    const oldHandle = account.handle;

    // Cascade update handle
    await c.env.DB.prepare(
      'UPDATE accounts SET handle = ?, nad_name = ?, previous_handle = ? WHERE wallet = ?'
    ).bind(name, `${name}.nad`, oldHandle, auth.wallet).run();

    for (const table of ['emails', 'daily_email_counts', 'credit_transactions', 'daily_emobuy_totals']) {
      await c.env.DB.prepare(
        `UPDATE ${table} SET handle = ? WHERE handle = ?`
      ).bind(name, oldHandle).run();
    }

    // Create meme coin if none exists
    if (!account.token_address) {
      try {
        const result = await createNadFunToken(name, auth.wallet, c.env);
        tokenAddress = result.tokenAddress;
        tokenSymbol = name.slice(0, 10).toUpperCase();

        await c.env.DB.prepare(
          'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
        ).bind(tokenAddress, tokenSymbol, result.tx, name).run();

        c.executionCtx.waitUntil(
          distributeInitialTokens(result.tokenAddress, auth.wallet, c.env),
        );
      } catch (e: any) {
        console.log(`[proxy-purchase] Token creation failed for ${name}: ${e.message}`);
      }
    }

    // Issue new JWT
    newJwt = await createToken({ wallet: auth.wallet, handle: name }, c.env.JWT_SECRET!);
    autoUpgraded = true;

    await c.env.DB.prepare(
      'UPDATE proxy_purchases SET auto_upgrade = 1 WHERE id = ?'
    ).bind(orderId).run();

    console.log(`[proxy-purchase] Auto-upgraded ${oldHandle} → ${name}`);
  }

  console.log(`[proxy-purchase] SUCCESS: ${name}.nad → ${auth.wallet} (order ${orderId}, tx ${purchaseResult.txHash})`);

  return c.json({
    success: true,
    order_id: orderId,
    name,
    nad_name: `${name}.nad`,
    purchase_tx: purchaseResult.txHash,
    payment_tx: txHash,
    price_mon: parseFloat(formatEther(priceWei)),
    fee_mon: parseFloat(formatEther(feeWei)),
    total_mon: parseFloat(formatEther(tx.value)),
    auto_upgraded: autoUpgraded,
    new_handle: autoUpgraded ? name : undefined,
    new_email: autoUpgraded ? `${name}@${c.env.DOMAIN}` : undefined,
    new_token: newJwt || undefined,
    token_address: tokenAddress || account?.token_address || undefined,
    token_symbol: tokenSymbol || undefined,
    next_steps: autoUpgraded
      ? 'Your handle has been upgraded! Use the new token for future API calls.'
      : account
        ? `Your .nad name is registered! Call POST /api/register/upgrade-handle { "new_handle": "${name}" } to update your email.`
        : `Register your NadMail account with POST /api/auth/agent-register { "handle": "${name}" }`,
  });
});

/**
 * GET /api/register/buy-nad-name/status/:orderId
 * Check proxy purchase order status.
 *
 * Auth: Bearer token
 */
registerRoutes.get('/buy-nad-name/status/:orderId', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  const orderId = c.req.param('orderId');

  const order = await c.env.DB.prepare(
    'SELECT * FROM proxy_purchases WHERE id = ? AND wallet = ?'
  ).bind(orderId, auth.wallet).first();

  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  return c.json({ order });
});

/**
 * Progressive 0x handle resolution.
 * Try 0x+8hex, then 0x+10hex, 0x+12hex... until unique.
 */
async function resolveUniqueWalletHandle(wallet: string, db: any): Promise<string> {
  const w = wallet.toLowerCase();
  for (let len = 10; len <= 42; len += 2) {
    const candidate = w.slice(0, len);
    const taken = await db.prepare(
      'SELECT handle FROM accounts WHERE handle = ?'
    ).bind(candidate).first();
    if (!taken) return candidate;
  }
  return w;
}
