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

export function generateAvatarSvg(handle: string): string {
  const hash = hashCode(handle);
  const hue1 = hash % 360;
  const hue2 = (hash * 7) % 360;
  const dicebearUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${handle}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:hsl(${hue1},80%,60%)"/>
      <stop offset="100%" style="stop-color:hsl(${hue2},80%,40%)"/>
    </linearGradient>
    <clipPath id="clip"><rect width="512" height="512" rx="64"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="64" fill="url(#g)"/>
  <image href="${dicebearUrl}" width="512" height="512" clip-path="url(#clip)" opacity="0.85"/>
</svg>`;
}

// ════════════════════════════════════════════
// Token 建立（使用 SDK createToken）
// ════════════════════════════════════════════

export async function createToken(
  handle: string,
  env: Env,
): Promise<{ tokenAddress: string; tx: string }> {
  const sdk = getSDK(env);

  const tokenName = `${handle}@${env.DOMAIN}`;
  const tokenSymbol = handle.toUpperCase();
  const description = `NadMail token for ${handle}@${env.DOMAIN}. Every email to this user is a micro-investment.`;

  // Generate avatar SVG
  const avatarSvg = generateAvatarSvg(handle);
  const avatarBlob = new Blob([avatarSvg], { type: 'image/svg+xml' });

  // Use SDK's all-in-one createToken
  const result = await sdk.createToken({
    name: tokenName,
    symbol: tokenSymbol,
    description,
    image: avatarBlob,
    imageContentType: 'image/svg+xml',
    website: `https://${env.DOMAIN}`,
  });

  return {
    tokenAddress: result.tokenAddress,
    tx: result.transactionHash,
  };
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
