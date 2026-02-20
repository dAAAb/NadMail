import { Hono } from 'hono';
import { Env } from '../types';
import { generateNonce, verifySiwe, createToken, buildSiweMessage } from '../auth';
import { createToken as createNadFunToken, distributeInitialTokens } from '../nadfun';
import { transferNadName } from '../nns-transfer';
import { getNadNamesForWallet } from '../nns-lookup';
import { executeNnsPurchase } from '../nns-purchase';

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
  const { address, signature, message, handle: requestedHandle, auto_nad, nad_name: requestedNadName } = await c.req.json<{
    address: string;
    signature: string;
    message: string;
    handle?: string;
    auto_nad?: boolean;
    nad_name?: string;
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
    let { token_address, token_symbol } = existingAccount;

    // Retry token creation if previous attempt failed
    if (!token_address) {
      try {
        const tokenResult = await createNadFunToken(existingAccount.handle, wallet, c.env);
        token_address = tokenResult.tokenAddress;
        // nad.fun enforces max 10 chars for symbol
        token_symbol = existingAccount.handle.slice(0, 10).toUpperCase();

        await c.env.DB.prepare(
          'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
        ).bind(token_address, token_symbol, tokenResult.tx, existingAccount.handle).run();

        c.executionCtx.waitUntil(
          distributeInitialTokens(tokenResult.tokenAddress, wallet, c.env)
        );
        console.log(`[agent-register] Token retry succeeded for ${existingAccount.handle}: ${token_address}`);
      } catch (e: any) {
        console.log(`[agent-register] Token retry failed for ${existingAccount.handle}: ${e.message}`);
      }
    }

    // NNS detection for 0x handle users
    let upgrade_available = false;
    let owned_nad_names: string[] = [];
    if (/^0x/i.test(existingAccount.handle)) {
      try {
        const names = await getNadNamesForWallet(wallet, c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz');
        owned_nad_names = names.map(n => n.toLowerCase());
        upgrade_available = owned_nad_names.length > 0;
      } catch { /* non-critical */ }
    }

    // Check if .nad is missing and auto_nad requested — buy it now
    let nad_name_status: string | undefined = undefined;
    let nad_purchase_tx: string | null = null;
    let purchase_hint: object | undefined = undefined;

    // Check current nad_name in DB
    const accountFull = await c.env.DB.prepare(
      'SELECT nad_name FROM accounts WHERE wallet = ?'
    ).bind(wallet).first<{ nad_name: string | null }>();

    // Verify on-chain ownership
    const currentNadName = accountFull?.nad_name;
    const handleForNad = existingAccount.handle;
    const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';

    if (currentNadName) {
      // DB says has nad_name — verify on chain
      const ownedNames = await getNadNamesForWallet(wallet, rpcUrl).catch(() => [] as string[]);
      const ownsIt = ownedNames.some(n => n.toLowerCase() === handleForNad.toLowerCase());
      if (ownsIt) {
        nad_name_status = 'owned';
      } else {
        // DB is wrong — fix it
        nad_name_status = 'not_purchased';
        await c.env.DB.prepare('UPDATE accounts SET nad_name = NULL WHERE wallet = ?').bind(wallet).run();
      }
    }

    // If no .nad on-chain and auto_nad requested, buy it
    if (nad_name_status !== 'owned' && auto_nad && !/^0x/i.test(handleForNad)) {
      try {
        const { createPublicClient: createPC, http: httpTransport } = await import('viem');
        const client = createPC({
          chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as any,
          transport: httpTransport(rpcUrl),
        });

        // Check availability
        const isAvailable = await client.readContract({
          address: '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7' as `0x${string}`,
          abi: [{ inputs: [{ name: 'name', type: 'string' }], name: 'isNameAvailable', outputs: [{ name: '', type: 'bool' }], stateMutability: 'view', type: 'function' }] as const,
          functionName: 'isNameAvailable',
          args: [handleForNad],
        });

        if (isAvailable) {
          // Get price
          const priceResult = await client.readContract({
            address: '0xdF0e18bb6d8c5385d285C3c67919E99c0dce020d' as `0x${string}`,
            abi: [{ inputs: [{ name: 'name', type: 'string' }, { name: 'token', type: 'address' }], name: 'getRegisteringPriceInToken', outputs: [{ components: [{ name: 'base', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }], type: 'tuple' }], stateMutability: 'view', type: 'function' }] as const,
            functionName: 'getRegisteringPriceInToken',
            args: [handleForNad, '0x0000000000000000000000000000000000000000' as `0x${string}`],
          });

          const priceWei = (priceResult as any).base as bigint;
          console.log(`[agent-register] Existing account auto-buy: ${handleForNad}.nad, price: ${priceWei} wei`);

          const purchaseResult = await executeNnsPurchase(handleForNad, wallet, priceWei, c.env);
          nad_purchase_tx = purchaseResult.txHash;
          nad_name_status = 'owned';

          // Update DB with real nad_name
          await c.env.DB.prepare('UPDATE accounts SET nad_name = ? WHERE wallet = ?')
            .bind(`${handleForNad}.nad`, wallet).run();

          console.log(`[agent-register] Auto-buy success for existing account: ${handleForNad}.nad → ${wallet}`);
        } else {
          // Name taken on NNS — check if platform wallet owns it (stuck transfer from previous auto_nad)
          const { privateKeyToAccount: pka } = await import('viem/accounts');
          const workerAddr = c.env.WALLET_PRIVATE_KEY
            ? pka(c.env.WALLET_PRIVATE_KEY as `0x${string}`).address.toLowerCase()
            : null;

          // Check who owns it via getNadNamesForWallet on platform wallet
          let platformOwnsIt = false;
          if (workerAddr) {
            const platformNames = await getNadNamesForWallet(workerAddr, rpcUrl).catch(() => [] as string[]);
            platformOwnsIt = platformNames.some(n => n.toLowerCase() === handleForNad.toLowerCase());
          }

          if (platformOwnsIt) {
            // Platform wallet has it — transfer to user
            console.log(`[agent-register] ${handleForNad}.nad owned by platform wallet, transferring to ${wallet}`);
            try {
              const transferTx = await transferNadName(handleForNad, wallet, c.env);
              nad_purchase_tx = transferTx;
              nad_name_status = 'owned';
              await c.env.DB.prepare('UPDATE accounts SET nad_name = ? WHERE wallet = ?')
                .bind(`${handleForNad}.nad`, wallet).run();
              console.log(`[agent-register] Transfer success: ${handleForNad}.nad → ${wallet}, tx: ${transferTx}`);
            } catch (e: any) {
              console.log(`[agent-register] Transfer from platform failed: ${e.message}`);
              nad_name_status = 'not_purchased';
              purchase_hint = {
                message: `${handleForNad}.nad was purchased but transfer failed: ${e.message}. Please contact support.`,
              };
            }
          } else {
            nad_name_status = 'not_purchased';
            purchase_hint = {
              message: `${handleForNad}.nad is already taken on NNS by someone else.`,
            };
          }
        }
      } catch (e: any) {
        console.log(`[agent-register] Auto-buy failed for existing account ${handleForNad}: ${e.message}`);
        nad_name_status = 'not_purchased';
        purchase_hint = {
          message: `Auto-buy failed: ${e.message}`,
          options: [
            { action: 'proxy_buy', method: 'POST /api/register/buy-nad-name', description: 'We buy it for you (send MON to cover cost)' },
            { action: 'buy_direct', url: 'https://app.nad.domains/', description: 'Buy directly, then POST /api/register/upgrade-handle' },
          ],
        };
      }
    } else if (nad_name_status !== 'owned' && !/^0x/i.test(handleForNad)) {
      nad_name_status = 'not_purchased';
      purchase_hint = {
        message: `Purchase ${handleForNad}.nad to own your name on-chain.`,
        options: [
          { action: 'auto_nad', method: 'POST /api/auth/agent-register', body: { auto_nad: true }, description: 'Re-call agent-register with auto_nad: true' },
          { action: 'proxy_buy', method: 'POST /api/register/buy-nad-name', description: 'We buy it for you (send MON to cover cost)' },
          { action: 'buy_direct', url: 'https://app.nad.domains/', description: 'Buy directly, then POST /api/register/upgrade-handle' },
        ],
      };
    }

    const token = await createToken({ wallet, handle: existingAccount.handle }, secret);

    // Phase 3: If user has 0x handle AND owns exactly one .nad name, offer auto_upgrade
    const auto_upgrade_available = upgrade_available && /^0x/i.test(existingAccount.handle) && owned_nad_names.length === 1;

    return c.json({
      token,
      email: `${existingAccount.handle}@${c.env.DOMAIN}`,
      handle: existingAccount.handle,
      wallet,
      token_address,
      token_symbol,
      tier: existingAccount.tier || 'free',
      registered: true,
      new_account: false,
      upgrade_available,
      auto_upgrade_available,
      nad_name_status,
      nad_purchase_tx,
      purchase_hint,
      owned_nad_names: upgrade_available ? owned_nad_names : undefined,
      upgrade_hint: upgrade_available
        ? auto_upgrade_available
          ? `You own ${owned_nad_names[0]}.nad! Call POST /api/register/upgrade-handle { "new_handle": "${owned_nad_names[0]}", "auto_upgrade": true } to upgrade your email from ${existingAccount.handle}@${c.env.DOMAIN} to ${owned_nad_names[0]}@${c.env.DOMAIN}.`
          : `You own .nad names! Call POST /api/register/upgrade-handle { "new_handle": "${owned_nad_names[0]}" } to upgrade.`
        : undefined,
    });
  }

  // Not registered — auto-register
  let handle: string;
  let nadName: string | null = null;
  let nftTransferTx: string | null = null;
  let detectedNadNames: string[] = [];
  let nadNameStatus: 'owned' | 'not_purchased' | 'reserved' | null = null;
  let purchaseHint: object | undefined = undefined;
  let autoBuyTx: string | null = null;

  let claimFreeName = false;

  // Resolve handle from auto_nad nad_name param or requestedHandle
  const effectiveHandle = requestedHandle || (auto_nad && requestedNadName ? requestedNadName.toLowerCase().trim().replace(/\.nad$/, '') : undefined);

  if (effectiveHandle) {
    handle = effectiveHandle.toLowerCase().trim();
    if (!isValidHandle(handle)) {
      return c.json({ error: 'Invalid handle format (3-20 chars, a-z, 0-9, _ only)' }, 400);
    }

    // Check if it's a free .nad name in our pool
    const freeName = await c.env.DB.prepare(
      'SELECT name, claimed_by FROM free_nad_names WHERE name = ?'
    ).bind(handle).first<{ name: string; claimed_by: string | null }>();

    if (freeName) {
      if (freeName.claimed_by !== null) {
        return c.json({ error: 'This name has already been claimed' }, 409);
      }
      claimFreeName = true;
      nadNameStatus = 'owned'; // Will be owned after free pool claim + transfer
    } else {
      // Not in free pool — check NNS on-chain status
      const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
      try {
        const { createPublicClient, http } = await import('viem');
        const client = createPublicClient({
          chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as any,
          transport: http(rpcUrl),
        });
        const isAvailable = await client.readContract({
          address: '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7',
          abi: [{ inputs: [{ name: 'name', type: 'string' }], name: 'isNameAvailable', outputs: [{ name: '', type: 'bool' }], stateMutability: 'view', type: 'function' }] as const,
          functionName: 'isNameAvailable',
          args: [handle],
        });

        if (!isAvailable) {
          // .nad name is taken on NNS — verify this wallet owns it
          const ownedNames = await getNadNamesForWallet(wallet, rpcUrl);
          const ownsIt = ownedNames.some(n => n.toLowerCase() === handle);
          if (!ownsIt) {
            return c.json({
              error: `${handle}.nad is owned by someone else on NNS. This handle is reserved for the .nad NFT holder.`,
              code: 'reserved_for_nns_owner',
              nad_name_status: 'reserved',
              hint: `If you own ${handle}.nad, make sure you're using the correct wallet. Otherwise, try a different handle or register with your wallet address.`,
            }, 403);
          }
          // Wallet owns this .nad NFT
          nadNameStatus = 'owned';
          nadName = `${handle}.nad`;
        } else {
          // Name is available on NNS — check if wallet already owns it (shouldn't, but be safe)
          const ownedNames = await getNadNamesForWallet(wallet, rpcUrl);
          const ownsIt = ownedNames.some(n => n.toLowerCase() === handle);

          if (ownsIt) {
            nadNameStatus = 'owned';
            nadName = `${handle}.nad`;
          } else if (auto_nad) {
            // Phase 2: Auto-buy .nad name
            try {
              // Query price
              const priceResult = await client.readContract({
                address: '0xdF0e18bb6d8c5385d285C3c67919E99c0dce020d' as `0x${string}`,
                abi: [{ inputs: [{ name: 'name', type: 'string' }, { name: 'token', type: 'address' }], name: 'getRegisteringPriceInToken', outputs: [{ components: [{ name: 'base', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }], type: 'tuple' }], stateMutability: 'view', type: 'function' }] as const,
                functionName: 'getRegisteringPriceInToken',
                args: [handle, '0x0000000000000000000000000000000000000000' as `0x${string}`],
              });

              const priceWei = (priceResult as any).base as bigint;
              console.log(`[agent-register] Auto-buying ${handle}.nad for ${wallet}, price: ${priceWei} wei`);

              // Execute purchase (Worker buys then transfers to user)
              const purchaseResult = await executeNnsPurchase(handle, wallet, priceWei, c.env);
              autoBuyTx = purchaseResult.txHash;
              nadNameStatus = 'owned';
              nadName = `${handle}.nad`;
              console.log(`[agent-register] Auto-buy success: ${handle}.nad → ${wallet}, tx: ${autoBuyTx}`);
            } catch (e: any) {
              console.log(`[agent-register] Auto-buy failed for ${handle}: ${e.message}`);
              // Fall through — register with handle but nadName = null
              nadNameStatus = 'not_purchased';
              nadName = null;
              purchaseHint = {
                message: `Auto-buy failed: ${e.message}. You can purchase ${handle}.nad manually.`,
                options: [
                  {
                    action: 'proxy_buy',
                    method: 'POST /api/register/buy-nad-name',
                    description: 'We buy it for you (send MON to cover cost)',
                  },
                  {
                    action: 'buy_direct',
                    url: 'https://app.nad.domains/',
                    description: 'Buy directly on NNS, then call POST /api/register/upgrade-handle',
                  },
                ],
              };
            }
          } else {
            // Phase 1: Name available but not purchased — honest status
            nadNameStatus = 'not_purchased';
            nadName = null;
            purchaseHint = {
              message: `Your handle is reserved! Purchase ${handle}.nad to own it on-chain.`,
              options: [
                {
                  action: 'auto_nad',
                  method: 'POST /api/auth/agent-register',
                  body: { handle, auto_nad: true },
                  description: 'Re-register with auto_nad: true to auto-purchase (platform pays)',
                },
                {
                  action: 'proxy_buy',
                  method: 'POST /api/register/buy-nad-name',
                  description: 'We buy it for you (send MON to cover cost)',
                },
                {
                  action: 'buy_direct',
                  url: 'https://app.nad.domains/',
                  description: 'Buy directly on NNS, then call POST /api/register/upgrade-handle',
                },
              ],
            };
          }
        }
      } catch (e: any) {
        // Non-critical: if NNS check fails, allow registration but with honest status
        console.log(`[agent-register] NNS availability check failed for ${handle}: ${e.message}`);
        nadNameStatus = null;
      }
    }

    // Only set nadName if not already set (owned or free pool)
    if (claimFreeName) {
      nadName = `${handle}.nad`;
    }
  } else {
    // Before falling back to 0x, detect owned .nad names for guidance
    const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
    try {
      const ownedNames = await getNadNamesForWallet(wallet, rpcUrl);
      detectedNadNames = ownedNames.map(n => n.toLowerCase());
    } catch { /* non-critical */ }

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

  // Claim free name + transfer NFT (only for names in our free pool)
  if (claimFreeName) {
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
    // nad.fun enforces max 10 chars for symbol
    tokenSymbol = handle.slice(0, 10).toUpperCase();

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

  // Build guidance for 0x handle users
  const isOxHandle = /^0x/i.test(handle);
  const guidance = isOxHandle ? {
    has_nad_name: detectedNadNames.length > 0,
    owned_nad_names: detectedNadNames.length > 0 ? detectedNadNames : undefined,
    buy_nad_name_url: 'https://app.nad.domains/',
    upgrade_endpoint: 'POST /api/register/upgrade-handle',
    suggested_action: detectedNadNames.length > 0 ? 'upgrade_handle' : 'buy_nad_name',
    message: detectedNadNames.length > 0
      ? `You own ${detectedNadNames[0]}.nad! Call POST /api/register/upgrade-handle { "new_handle": "${detectedNadNames[0]}" } to upgrade your email.`
      : 'Get a .nad name at https://app.nad.domains/ for a memorable email + meme coin. After purchasing, call POST /api/register/upgrade-handle.',
  } : undefined;

  return c.json({
    token,
    email: `${handle}@${c.env.DOMAIN}`,
    handle,
    wallet,
    nad_name: nadName,
    nad_name_status: nadNameStatus,
    purchase_hint: purchaseHint,
    auto_buy_tx: autoBuyTx,
    nft_transfer_tx: nftTransferTx,
    token_address: tokenAddress,
    token_symbol: tokenSymbol,
    tier: 'free',
    registered: true,
    new_account: true,
    pending_emails: pendingResult?.count || 0,
    migrated_emails: migratedCount,
    guidance,
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

  // NNS detection for 0x handle users
  let upgrade_available = false;
  let owned_nad_names: string[] = [];

  if (account && /^0x/i.test(account.handle)) {
    try {
      const names = await getNadNamesForWallet(wallet, c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz');
      owned_nad_names = names.map(n => n.toLowerCase());
      upgrade_available = owned_nad_names.length > 0;
    } catch { /* non-critical */ }
  }

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
    upgrade_available,
    owned_nad_names: upgrade_available ? owned_nad_names : undefined,
    upgrade_hint: upgrade_available
      ? `You own .nad names! Call POST /api/register/upgrade-handle { "new_handle": "${owned_nad_names[0]}" } to upgrade.`
      : undefined,
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
