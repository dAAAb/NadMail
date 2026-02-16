import { Hono } from 'hono';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Env } from '../types';
import { sendInternalEmail } from '../send-internal';
import { getNadNamesForWallet } from '../nns-lookup';
import { createToken as createNadFunToken, distributeInitialTokens } from '../nadfun';
import { createToken } from '../auth';

export const adminRoutes = new Hono<{ Bindings: Env }>();

const ADMIN_HANDLES = ['diplomat', 'nadmail'];
const ADMIN_DAILY_LIMIT = 100;

/**
 * Admin auth middleware — verifies ADMIN_SECRET
 */
function adminAuth() {
  return async (c: any, next: any) => {
    const secret = c.env.ADMIN_SECRET;
    if (!secret) {
      return c.json({ error: 'Admin API not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== secret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}

/**
 * POST /api/admin/send
 * Send email as an admin account (diplomat or nadmail).
 * Auth: Bearer ADMIN_SECRET
 *
 * Body: { from_handle, to, subject, body, emo_amount? }
 */
adminRoutes.post('/send', adminAuth(), async (c) => {
  const body = await c.req.json<{
    from_handle: string;
    to: string;
    subject: string;
    body: string;
    emo_amount?: number;
  }>().catch(() => null);

  if (!body || !body.from_handle || !body.to || !body.subject || !body.body) {
    return c.json({ error: 'from_handle, to, subject, and body are required' }, 400);
  }

  const fromHandle = body.from_handle.toLowerCase();

  if (!ADMIN_HANDLES.includes(fromHandle)) {
    return c.json({
      error: `from_handle must be one of: ${ADMIN_HANDLES.join(', ')}`,
    }, 403);
  }

  // Look up sender account
  const sender = await c.env.DB.prepare(
    'SELECT handle, wallet FROM accounts WHERE handle = ?'
  ).bind(fromHandle).first<{ handle: string; wallet: string }>();

  if (!sender) {
    return c.json({ error: `Account not found: ${fromHandle}` }, 404);
  }

  // Admin rate limit (100/day)
  const today = new Date().toISOString().split('T')[0];
  const dailyCount = await c.env.DB.prepare(
    'SELECT count FROM daily_email_counts WHERE handle = ? AND date = ?'
  ).bind(`admin:${fromHandle}`, today).first<{ count: number }>();

  if (dailyCount && dailyCount.count >= ADMIN_DAILY_LIMIT) {
    return c.json({
      error: `Admin daily limit reached (${ADMIN_DAILY_LIMIT}/day)`,
      limit: ADMIN_DAILY_LIMIT,
      used: dailyCount.count,
    }, 429);
  }

  // Track admin sends separately
  await c.env.DB.prepare(
    `INSERT INTO daily_email_counts (handle, date, count) VALUES (?, ?, 1)
     ON CONFLICT(handle, date) DO UPDATE SET count = count + 1`
  ).bind(`admin:${fromHandle}`, today).run();

  // Send
  const isInternal = body.to.toLowerCase().endsWith(`@${c.env.DOMAIN}`);

  if (!isInternal) {
    return c.json({ error: 'Admin send only supports internal @nadmail.ai recipients' }, 400);
  }

  try {
    const result = await sendInternalEmail(c.env, {
      fromHandle: sender.handle,
      fromWallet: sender.wallet,
      to: body.to,
      subject: body.subject,
      body: body.body,
      emo_amount: body.emo_amount,
    });

    console.log(`[admin] ${fromHandle} → ${body.to}: ${result.email_id}`);

    const response: Record<string, unknown> = {
      success: true,
      email_id: result.email_id,
      from: `${sender.handle}@${c.env.DOMAIN}`,
      to: body.to,
      subject: body.subject,
    };

    if (result.microbuy) {
      response.microbuy = {
        tx: result.microbuy.tx,
        amount: `${result.microbuy.totalMonSpent} MON`,
        tokens_received: `$${result.microbuy.tokenSymbol}`,
        tokens_bought: result.microbuy.tokensBought,
      };
    }

    return c.json(response);
  } catch (e: any) {
    console.log(`[admin] Send failed: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }
});

const NNS_CONTRACT = '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7' as const;
const NNS_PROXY = '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7' as const;
const proxyAbi = [
  {
    inputs: [{ name: 'name', type: 'string' }],
    name: 'isNameAvailable',
    outputs: [{ name: '', type: 'bool' }],
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

/**
 * GET /api/admin/audit-handles
 * Find accounts with non-0x handles that don't own the corresponding .nad name.
 * Auth: Bearer ADMIN_SECRET
 */
adminRoutes.get('/audit-handles', adminAuth(), async (c) => {
  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
  const client = createPublicClient({ chain: monad, transport: http(rpcUrl) });

  // Get all accounts with non-0x handles
  const rows = await c.env.DB.prepare(
    "SELECT handle, wallet, nad_name, token_address, token_symbol, created_at FROM accounts WHERE handle NOT LIKE '0x%' ORDER BY created_at"
  ).all<{ handle: string; wallet: string; nad_name: string | null; token_address: string | null; token_symbol: string | null; created_at: number }>();

  const accounts = rows.results || [];
  const issues: any[] = [];
  const ok: any[] = [];

  for (const acc of accounts) {
    // Skip admin/system handles
    if (['diplomat', 'nadmail'].includes(acc.handle)) {
      ok.push({ handle: acc.handle, status: 'system_account' });
      continue;
    }

    // Check if the .nad name is available on NNS (meaning nobody owns it)
    let nnsAvailable = true;
    try {
      nnsAvailable = await client.readContract({
        address: NNS_PROXY,
        abi: proxyAbi,
        functionName: 'isNameAvailable',
        args: [acc.handle],
      });
    } catch {
      // If check fails, skip
      ok.push({ handle: acc.handle, status: 'nns_check_failed' });
      continue;
    }

    if (nnsAvailable) {
      // .nad is available — this handle was claimed without NNS ownership
      // Check if it came from our free pool
      const freeName = await c.env.DB.prepare(
        'SELECT name, claimed_by FROM free_nad_names WHERE name = ?'
      ).bind(acc.handle).first<{ name: string; claimed_by: string | null }>();

      if (freeName && freeName.claimed_by === acc.wallet) {
        ok.push({ handle: acc.handle, status: 'free_pool_claim', wallet: acc.wallet });
        continue;
      }

      issues.push({
        handle: acc.handle,
        wallet: acc.wallet,
        token_address: acc.token_address,
        token_symbol: acc.token_symbol,
        nad_name: acc.nad_name,
        reason: 'nns_available_but_handle_claimed',
        description: `${acc.handle}.nad is available on NNS but claimed on NadMail without ownership`,
      });
    } else {
      // .nad is taken — check if this wallet owns it
      let ownedNames: string[] = [];
      try {
        ownedNames = await getNadNamesForWallet(acc.wallet, rpcUrl);
      } catch { /* skip */ }

      const ownsIt = ownedNames.some(n => n.toLowerCase() === acc.handle);

      if (ownsIt) {
        ok.push({ handle: acc.handle, status: 'legitimate_owner', wallet: acc.wallet });
      } else {
        issues.push({
          handle: acc.handle,
          wallet: acc.wallet,
          token_address: acc.token_address,
          token_symbol: acc.token_symbol,
          nad_name: acc.nad_name,
          reason: 'nns_owned_by_others',
          description: `${acc.handle}.nad is owned by someone else on NNS, not by wallet ${acc.wallet.slice(0, 10)}...`,
        });
      }
    }
  }

  return c.json({
    total_accounts: accounts.length,
    issues_found: issues.length,
    ok_count: ok.length,
    issues,
    ok,
  });
});

/**
 * POST /api/admin/downgrade-handles
 * Downgrade illegitimate handles back to 0x addresses.
 * Auth: Bearer ADMIN_SECRET
 * Body: { handles: ["openclaw", ...], dry_run?: boolean, notify?: boolean }
 */
adminRoutes.post('/downgrade-handles', adminAuth(), async (c) => {
  const body = await c.req.json<{
    handles: string[];
    dry_run?: boolean;
    notify?: boolean;
  }>().catch(() => null);

  if (!body || !body.handles || body.handles.length === 0) {
    return c.json({ error: 'handles array is required' }, 400);
  }

  const dryRun = body.dry_run !== false; // Default: dry_run=true for safety
  const notify = body.notify ?? true;
  const results: any[] = [];

  for (const handle of body.handles) {
    const h = handle.toLowerCase().trim();

    const account = await c.env.DB.prepare(
      'SELECT handle, wallet, token_address, token_symbol, nad_name FROM accounts WHERE handle = ?'
    ).bind(h).first<{ handle: string; wallet: string; token_address: string | null; token_symbol: string | null; nad_name: string | null }>();

    if (!account) {
      results.push({ handle: h, status: 'not_found' });
      continue;
    }

    // Resolve new 0x handle
    const wallet = account.wallet;
    let newHandle = wallet.slice(0, 10); // 0x + 8 hex
    let suffix = 10;
    while (suffix <= 42) {
      const existing = await c.env.DB.prepare(
        'SELECT handle FROM accounts WHERE handle = ? AND wallet != ?'
      ).bind(newHandle, wallet).first();
      if (!existing) break;
      suffix += 2;
      newHandle = wallet.slice(0, suffix);
    }

    if (dryRun) {
      results.push({
        handle: h,
        new_handle: newHandle,
        wallet: account.wallet,
        token_address: account.token_address,
        token_symbol: account.token_symbol,
        status: 'would_downgrade',
      });
      continue;
    }

    // Execute downgrade
    try {
    const now = Math.floor(Date.now() / 1000);
    const newTokenSymbol = account.token_address ? newHandle.slice(0, 10).toUpperCase() : account.token_symbol;

    // FK: D1 checks on child INSERT/UPDATE that parent exists.
    // So update PARENT first (changes PK but doesn't trigger child FK checks),
    // THEN update children to match new PK (now parent exists).
    await c.env.DB.prepare(
      'UPDATE accounts SET handle = ?, nad_name = NULL, previous_handle = ?, token_symbol = ? WHERE wallet = ?'
    ).bind(newHandle, h, newTokenSymbol || null, wallet).run();

    await c.env.DB.prepare('UPDATE emails SET handle = ? WHERE handle = ?').bind(newHandle, h).run();
    await c.env.DB.prepare('UPDATE daily_email_counts SET handle = ? WHERE handle = ?').bind(newHandle, h).run();
    await c.env.DB.prepare('UPDATE credit_transactions SET handle = ? WHERE handle = ?').bind(newHandle, h).run();
    await c.env.DB.prepare('UPDATE daily_emobuy_totals SET handle = ? WHERE handle = ?').bind(newHandle, h).run();

    let newTokenAddress = account.token_address;

    // 7. Notify the user
    if (notify) {
      try {
        // Look up diplomat account for sending
        const diplomat = await c.env.DB.prepare(
          'SELECT handle, wallet FROM accounts WHERE handle = ?'
        ).bind('diplomat').first<{ handle: string; wallet: string }>();

        if (diplomat) {
          await sendInternalEmail(c.env, {
            fromHandle: diplomat.handle,
            fromWallet: diplomat.wallet,
            to: `${newHandle}@${c.env.DOMAIN}`,
            subject: `📋 Handle Update: ${h} → ${newHandle}`,
            body: `Hi there!\n\nYour NadMail handle has been updated from "${h}" to "${newHandle}".\n\nWhy? NadMail now reserves handles for .nad name owners. Since ${h}.nad is not owned by your wallet, the handle has been released.\n\nWhat you can do:\n• Continue using ${newHandle}@nadmail.ai\n• Buy ${h}.nad at https://app.nad.domains/ to reclaim the handle\n• Your existing emails and tokens are preserved\n\nSorry for the inconvenience!\n— NadMail Team`,
          });
        }
      } catch (e: any) {
        console.log(`[admin] Notification failed for ${newHandle}: ${e.message}`);
      }
    }

    console.log(`[admin] Downgraded: ${h} → ${newHandle} (wallet: ${wallet})`);

    results.push({
      handle: h,
      new_handle: newHandle,
      new_email: `${newHandle}@${c.env.DOMAIN}`,
      wallet: account.wallet,
      token_address: newTokenAddress,
      old_token_symbol: account.token_symbol,
      new_token_symbol: newTokenSymbol,
      notified: notify,
      status: 'downgraded',
    });
    } catch (e: any) {
      console.log(`[admin] Downgrade failed for ${h}: ${e.message}`);
      results.push({ handle: h, status: 'error', error: e.message });
    }
  }

  return c.json({
    dry_run: dryRun,
    results,
  });
});

/**
 * POST /api/admin/transfer-nad
 * Transfer a .nad NFT from Worker to a user + upgrade their handle.
 * For completing proxy purchases where registration succeeded but transfer timed out.
 * Auth: Bearer ADMIN_SECRET
 * Body: { name: "openclaw", to_wallet: "0x...", token_id?: number }
 */
adminRoutes.post('/transfer-nad', adminAuth(), async (c) => {
  const body = await c.req.json<{ name: string; to_wallet: string; token_id?: number }>().catch(() => null);
  if (!body?.name || !body?.to_wallet) {
    return c.json({ error: 'name and to_wallet required' }, 400);
  }

  const name = body.name.toLowerCase().trim();
  const toWallet = body.to_wallet.toLowerCase();

  if (!c.env.WALLET_PRIVATE_KEY) {
    return c.json({ error: 'Worker wallet not configured' }, 503);
  }

  const account = privateKeyToAccount(c.env.WALLET_PRIVATE_KEY as Hex);
  const rpcUrl = c.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';

  const walletClient = createWalletClient({
    account, chain: monad, transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: monad, transport: http(rpcUrl),
  });

  // Find tokenId if not provided
  let tokenId = body.token_id ? BigInt(body.token_id) : null;

  if (!tokenId) {
    // Search Worker's NFTs for this name
    const erc721Enum = [
      { inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view' as const, type: 'function' as const },
      { inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }], name: 'tokenOfOwnerByIndex', outputs: [{ type: 'uint256' }], stateMutability: 'view' as const, type: 'function' as const },
    ];

    const balance = await publicClient.readContract({
      address: NNS_CONTRACT, abi: erc721Enum, functionName: 'balanceOf', args: [account.address],
    }) as bigint;

    // Check last 20 NFTs (most recent first)
    // We verify by checking if NNS resolves this tokenId to the right name
    const checkCount = Math.min(Number(balance), 20);
    for (let i = Number(balance) - 1; i >= Number(balance) - checkCount; i--) {
      const tid = await publicClient.readContract({
        address: NNS_CONTRACT, abi: erc721Enum, functionName: 'tokenOfOwnerByIndex', args: [account.address, BigInt(i)],
      }) as bigint;

      // For now, use the most recent token (proxy buy was the latest registration)
      // A more robust approach would query tokenURI or reverse-resolve
      tokenId = tid;
      break; // Take the most recent
    }
  }

  if (!tokenId) {
    return c.json({ error: 'Could not find tokenId for this name' }, 404);
  }

  // Transfer NFT
  const erc721Transfer = [{
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
    name: 'transferFrom', outputs: [], stateMutability: 'nonpayable' as const, type: 'function' as const,
  }];

  try {
    const txHash = await walletClient.writeContract({
      address: NNS_CONTRACT,
      abi: erc721Transfer,
      functionName: 'transferFrom',
      args: [account.address, toWallet as `0x${string}`, tokenId],
      gas: 500_000n,
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });

    // Now upgrade the user's handle on NadMail
    const acct = await c.env.DB.prepare(
      'SELECT handle, token_address FROM accounts WHERE wallet = ?'
    ).bind(toWallet).first<{ handle: string; token_address: string | null }>();

    let upgraded = false;
    let newToken: string | null = null;
    let tokenAddress: string | null = null;

    if (acct && acct.handle.startsWith('0x')) {
      const oldHandle = acct.handle;

      // Cascade update
      await c.env.DB.prepare('UPDATE emails SET handle = ? WHERE handle = ?').bind(name, oldHandle).run();
      await c.env.DB.prepare('UPDATE daily_email_counts SET handle = ? WHERE handle = ?').bind(name, oldHandle).run();
      await c.env.DB.prepare('UPDATE credit_transactions SET handle = ? WHERE handle = ?').bind(name, oldHandle).run();
      await c.env.DB.prepare('UPDATE daily_emobuy_totals SET handle = ? WHERE handle = ?').bind(name, oldHandle).run();
      await c.env.DB.prepare(
        'UPDATE accounts SET handle = ?, nad_name = ?, previous_handle = ? WHERE wallet = ?'
      ).bind(name, `${name}.nad`, oldHandle, toWallet).run();

      // Create meme coin
      if (!acct.token_address) {
        try {
          const result = await createNadFunToken(name, toWallet, c.env);
          tokenAddress = result.tokenAddress;
          const tokenSymbol = name.slice(0, 10).toUpperCase();
          await c.env.DB.prepare(
            'UPDATE accounts SET token_address = ?, token_symbol = ?, token_create_tx = ? WHERE handle = ?'
          ).bind(tokenAddress, tokenSymbol, result.tx, name).run();
          c.executionCtx.waitUntil(distributeInitialTokens(tokenAddress, toWallet, c.env));
        } catch (e: any) {
          console.log(`[admin/transfer] Token creation failed: ${e.message}`);
        }
      }

      newToken = await createToken({ wallet: toWallet, handle: name }, c.env.JWT_SECRET!);
      upgraded = true;
    }

    return c.json({
      success: true,
      name,
      transfer_tx: txHash,
      token_id: tokenId.toString(),
      to_wallet: toWallet,
      upgraded,
      new_handle: upgraded ? name : undefined,
      new_email: upgraded ? `${name}@${c.env.DOMAIN}` : undefined,
      token_address: tokenAddress || acct?.token_address,
    });
  } catch (e: any) {
    return c.json({ error: `Transfer failed: ${e.message}` }, 500);
  }
});
