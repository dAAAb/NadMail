/**
 * nad.fun 整合模組（使用官方 @nadfun/sdk）
 * Token 建立、Micro-buy、Avatar 生成、價格查詢
 */

import { initSDK, parseEther, formatEther, type NadFunSDK, type Address } from '@nadfun/sdk';
import { Env } from './types';

// ─── SDK singleton cache ──────────────────────────

let _sdk: NadFunSDK | null = null;

function getSDK(env: Env): NadFunSDK {
  if (!env.WALLET_PRIVATE_KEY) throw new Error('Worker wallet not configured');
  // Re-create each time since env changes per request in Workers
  _sdk = initSDK({
    rpcUrl: env.MONAD_RPC_URL,
    privateKey: env.WALLET_PRIVATE_KEY as `0x${string}`,
    network: 'mainnet',
  });
  return _sdk;
}

// ════════════════════════════════════════════
// Avatar 生成
// ════════════════════════════════════════════

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export async function generateAvatarSvg(handle: string): Promise<string> {
  const hash = hashCode(handle);
  const hue1 = hash % 360;
  const hue2 = (hash * 7) % 360;

  // Fetch dicebear robot SVG and inline its elements directly.
  // We can't use <image href="data:image/svg+xml;base64,..."> because browsers
  // block SVG-in-SVG when the outer SVG is loaded via <img> tag (security).
  let robotInline = '';
  try {
    const res = await fetch(`https://api.dicebear.com/7.x/bottts/svg?seed=${handle}`);
    if (res.ok) {
      const svgText = await res.text();
      const cleaned = svgText.replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/g, '');
      // Extract inner SVG content (between <svg ...> and </svg>)
      const innerMatch = cleaned.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
      if (innerMatch) {
        // Scale from dicebear's 180x180 viewBox to our 512x512
        const scale = (512 / 180).toFixed(4);
        robotInline = `<g clip-path="url(#clip)" opacity="0.85"><g transform="scale(${scale})" fill="none" shape-rendering="auto">${innerMatch[1]}</g></g>`;
      }
    }
  } catch (e) {
    // Fallback: gradient-only background
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:hsl(${hue1},80%,60%)"/>
      <stop offset="100%" style="stop-color:hsl(${hue2},80%,40%)"/>
    </linearGradient>
    <clipPath id="clip"><rect width="512" height="512" rx="64"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="64" fill="url(#g)"/>
  ${robotInline}
</svg>`;
}

// ════════════════════════════════════════════
// Token 建立（使用 SDK createToken）
// ════════════════════════════════════════════

const INITIAL_BUY_AMOUNT = parseEther('1'); // 1 MON initial buy per token

export async function createToken(
  handle: string,
  creatorWallet: string,
  env: Env,
): Promise<{ tokenAddress: string; tx: string }> {
  const sdk = getSDK(env);

  const isWalletHandle = /^0x[a-f0-9]{40}$/.test(handle);
  // Token name max 32 chars: 0x users get short prefix, .nad users get full handle
  const shortHandle = isWalletHandle ? handle.slice(0, 10) : handle;
  const tokenName = `${shortHandle}@${env.DOMAIN}`;
  // nad.fun enforces max 10 chars for symbol
  const tokenSymbol = (isWalletHandle ? shortHandle : handle).slice(0, 10).toUpperCase();
  const description = isWalletHandle
    ? `NadMail token for ${shortHandle}...@${env.DOMAIN}. Every email to this user is a micro-investment.`
    : `NadMail token for ${handle}@${env.DOMAIN}. Every email to this user is a micro-investment.`;

  // Generate avatar SVG (fetches dicebear robot + embeds inline)
  const avatarSvg = await generateAvatarSvg(handle);
  const avatarBlob = new Blob([avatarSvg], { type: 'image/svg+xml' });

  // Create token with 1 MON initial buy — tokens go to Worker wallet
  const result = await sdk.createToken({
    name: tokenName,
    symbol: tokenSymbol,
    description,
    image: avatarBlob,
    imageContentType: 'image/svg+xml',
    website: `https://${env.DOMAIN}`,
    initialBuyAmount: INITIAL_BUY_AMOUNT,
  });

  return {
    tokenAddress: result.tokenAddress,
    tx: result.transactionHash,
  };
}

/**
 * Distribute initial tokens: 50/50 split between creator and platform.
 * Designed to run in background via waitUntil() — NOT blocking the response.
 */
export async function distributeInitialTokens(
  tokenAddress: string,
  creatorWallet: string,
  env: Env,
): Promise<void> {
  try {
    const sdk = getSDK(env);

    const workerBalance = await sdk.getBalance(
      tokenAddress as Address,
      sdk.account.address,
    );

    if (workerBalance === 0n) {
      console.log(`[distribute] No tokens to distribute for ${tokenAddress}`);
      return;
    }

    const creatorShare = workerBalance / 2n;
    if (creatorShare > 0n) {
      await sdk.transfer(
        tokenAddress as Address,
        creatorWallet as Address,
        creatorShare,
      );
      console.log(`[distribute] Sent ${formatEther(creatorShare)} tokens to ${creatorWallet}, kept ${formatEther(workerBalance - creatorShare)} for platform`);
    }
  } catch (e: any) {
    console.log(`[distribute] Failed for ${tokenAddress}: ${e.message}`);
  }
}

// ════════════════════════════════════════════
// Micro-buy（寄信時觸發）
// ════════════════════════════════════════════

const MICRO_BUY_AMOUNT = parseEther('0.001'); // 0.001 MON per email

export async function microBuy(
  tokenAddress: string,
  senderWallet: string,
  env: Env,
): Promise<string> {
  const sdk = getSDK(env);

  // Use SDK's simpleBuy — tokens go to sender's wallet
  const hash = await sdk.simpleBuy({
    token: tokenAddress as Address,
    amountIn: MICRO_BUY_AMOUNT,
    slippagePercent: 5, // 5% slippage for micro amounts
    to: senderWallet as Address,
  });

  return hash;
}

// ════════════════════════════════════════════
// Micro-buy with price data（簽名檔用）
// ════════════════════════════════════════════

export interface MicroBuyResult {
  tx: string;
  tokensBought: string;       // e.g. "142.5"
  priceBeforeMon: string;     // MON per token, before buy
  priceAfterMon: string;      // MON per token, after buy
  priceChangePercent: string; // e.g. "+2.8"
  tokenSymbol: string;
  tokenAddress: string;
}

export async function microBuyWithPrice(
  tokenAddress: string,
  tokenSymbol: string,
  senderWallet: string,
  env: Env,
): Promise<MicroBuyResult> {
  const sdk = getSDK(env);
  const token = tokenAddress as Address;

  // 1. Pre-buy quote: how many tokens will 0.001 MON buy?
  const { amount: tokensBefore } = await sdk.getAmountOut(token, MICRO_BUY_AMOUNT, true);
  // price = MON spent / tokens received
  const priceBefore = tokensBefore > 0n
    ? Number(MICRO_BUY_AMOUNT) / Number(tokensBefore)
    : 0;

  // 2. Execute buy
  const tx = await sdk.simpleBuy({
    token,
    amountIn: MICRO_BUY_AMOUNT,
    slippagePercent: 5,
    to: senderWallet as Address,
  });

  // 3. Post-buy quote: same MON amount now buys fewer tokens (price went up)
  const { amount: tokensAfter } = await sdk.getAmountOut(token, MICRO_BUY_AMOUNT, true);
  const priceAfter = tokensAfter > 0n
    ? Number(MICRO_BUY_AMOUNT) / Number(tokensAfter)
    : 0;

  // 4. Calculate change
  const changePercent = priceBefore > 0
    ? ((priceAfter - priceBefore) / priceBefore) * 100
    : 0;

  return {
    tx,
    tokensBought: formatTokenAmount(tokensBefore),
    priceBeforeMon: formatPrice(priceBefore),
    priceAfterMon: formatPrice(priceAfter),
    priceChangePercent: changePercent >= 0 ? `+${changePercent.toFixed(2)}` : changePercent.toFixed(2),
    tokenSymbol,
    tokenAddress,
  };
}

function formatPrice(price: number): string {
  if (price === 0) return '0';
  if (price >= 0.01) return price.toFixed(6);
  // For very small prices, use significant digits
  return price.toPrecision(4);
}

function formatTokenAmount(amount: bigint): string {
  const f = formatEther(amount);
  const n = parseFloat(f);
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(4);
}

// ════════════════════════════════════════════
// 價格查詢
// ════════════════════════════════════════════

export async function getTokenPrice(
  tokenAddress: string,
  env: Env,
): Promise<{ priceInMon: string; graduated: boolean }> {
  const sdk = getSDK(env);

  // 查詢 1 MON 可以買多少 token
  const { amount: amountOut } = await sdk.getAmountOut(
    tokenAddress as Address,
    parseEther('1'),
    true,
  );

  const graduated = await sdk.isGraduated(tokenAddress as Address);

  // Price = 1 / amountOut (MON per token)
  const priceInMon = amountOut > 0n
    ? formatEther(parseEther('1') * parseEther('1') / amountOut)
    : '0';

  return { priceInMon, graduated };
}

export async function getTokenBalance(
  tokenAddress: string,
  wallet: string,
  env: Env,
): Promise<string> {
  const sdk = getSDK(env);
  const balance = await sdk.getBalance(tokenAddress as Address, wallet as Address);
  return formatEther(balance);
}
