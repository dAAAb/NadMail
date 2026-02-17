/**
 * Email signature builder — static or dynamic with micro-buy price data
 */

import type { MicroBuyResult } from './nadfun';

const NADFUN_BASE = 'https://nad.fun/tokens';

// ── Static fallback (no micro-buy data) ──

export function buildTextSignature(): string {
  return `\n\n--\nSent via NadMail.ai — Your Email is Your Meme Coin\nhttps://nadmail.ai`;
}

export function buildHtmlSignature(): string {
  return `<br><br><div style="border-top:1px solid #333;padding-top:12px;margin-top:24px;font-size:12px;color:#888;font-family:sans-serif;">Sent via <a href="https://nadmail.ai" style="color:#7B3FE4;text-decoration:none;font-weight:bold;">NadMail.ai</a> &mdash; Your Email is Your Meme Coin</div>`;
}

// ── Dynamic with micro-buy price data ──

export function buildTextSignatureWithPrice(mb: MicroBuyResult, emoAmount?: number): string {
  if (emoAmount && emoAmount > 0) {
    return buildTextSignatureWithEmo(mb, emoAmount);
  }
  return `\n\n--\n` +
    `This email just micro-bought $${mb.tokenSymbol} tokens!\n` +
    `   ${mb.totalMonSpent} MON → ${mb.tokensBought} $${mb.tokenSymbol} (${NADFUN_BASE}/${mb.tokenAddress})\n` +
    `   Price: ${mb.priceBeforeMon} → ${mb.priceAfterMon} MON (${mb.priceChangePercent}%)\n\n` +
    `Sent via NadMail.ai -- Your Email is Your Meme Coin\nhttps://nadmail.ai`;
}

export function buildHtmlSignatureWithPrice(mb: MicroBuyResult, emoAmount?: number): string {
  if (emoAmount && emoAmount > 0) {
    return buildHtmlSignatureWithEmo(mb, emoAmount);
  }
  const changeColor = mb.priceChangePercent.startsWith('+') ? '#00C853' : '#FF5252';

  return `<br><br>` +
    `<div style="border-top:1px solid #333;padding-top:12px;margin-top:24px;font-size:13px;color:#ccc;font-family:sans-serif;">` +
      `<div style="margin-bottom:8px;">` +
        `<span style="color:#00C853;">&#x1F4C8;</span> ` +
        `<strong>This email just micro-bought <span style="color:#7B3FE4;">$${mb.tokenSymbol}</span> tokens!</strong>` +
      `</div>` +
      `<div style="background:#1a1a2e;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;margin-bottom:8px;color:#ddd;">` +
        `<div>&#x1F4B0; ${mb.totalMonSpent} MON &rarr; <strong>${mb.tokensBought} <a href="${NADFUN_BASE}/${mb.tokenAddress}" style="color:#7B3FE4;text-decoration:none;">$${mb.tokenSymbol}</a></strong></div>` +
        `<div>&#x1F4CA; Price: ${mb.priceBeforeMon} &rarr; ${mb.priceAfterMon} MON <span style="color:${changeColor};">(${mb.priceChangePercent}%)</span></div>` +
      `</div>` +
      `<div style="font-size:11px;color:#888;">` +
        `Sent via <a href="https://nadmail.ai" style="color:#7B3FE4;text-decoration:none;">NadMail.ai</a> &mdash; Your Email is Your Meme Coin` +
      `</div>` +
    `</div>`;
}

// ── Emo-boost signatures (higher amounts, flashier styling) ──

function buildTextSignatureWithEmo(mb: MicroBuyResult, emoAmount: number): string {
  return `\n\n--\n` +
    `🔥 This email EMO-BOOSTED $${mb.tokenSymbol} with ${mb.totalMonSpent} MON!\n` +
    `   Base: 0.001 + Boost: ${emoAmount} MON → ${mb.tokensBought} $${mb.tokenSymbol} (${NADFUN_BASE}/${mb.tokenAddress})\n` +
    `   Price: ${mb.priceBeforeMon} → ${mb.priceAfterMon} MON (${mb.priceChangePercent}%)\n\n` +
    `Sent via NadMail.ai -- Your Email is Your Meme Coin\nhttps://nadmail.ai`;
}

function buildHtmlSignatureWithEmo(mb: MicroBuyResult, emoAmount: number): string {
  const changeColor = mb.priceChangePercent.startsWith('+') ? '#00C853' : '#FF5252';

  return `<br><br>` +
    `<div style="border-top:2px solid #7B3FE4;padding-top:12px;margin-top:24px;font-size:13px;color:#ccc;font-family:sans-serif;">` +
      `<div style="margin-bottom:8px;">` +
        `<span style="font-size:16px;">&#x1F525;</span> ` +
        `<strong>This email <span style="color:#FF6B00;">EMO-BOOSTED</span> <span style="color:#7B3FE4;">$${mb.tokenSymbol}</span>!</strong>` +
      `</div>` +
      `<div style="background:linear-gradient(135deg,#1a1a2e,#2d1b4e);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;margin-bottom:8px;color:#ddd;border:1px solid #7B3FE4;">` +
        `<div>&#x1F4B0; ${mb.totalMonSpent} MON &rarr; <strong>${mb.tokensBought} <a href="${NADFUN_BASE}/${mb.tokenAddress}" style="color:#7B3FE4;text-decoration:none;">$${mb.tokenSymbol}</a></strong></div>` +
        `<div style="font-size:11px;color:#aaa;">Base: 0.001 + Boost: ${emoAmount} MON</div>` +
        `<div>&#x1F4CA; Price: ${mb.priceBeforeMon} &rarr; ${mb.priceAfterMon} MON <span style="color:${changeColor};font-weight:bold;">(${mb.priceChangePercent}%)</span></div>` +
      `</div>` +
      `<div style="font-size:11px;color:#888;">` +
        `Sent via <a href="https://nadmail.ai" style="color:#7B3FE4;text-decoration:none;">NadMail.ai</a> &mdash; Your Email is Your Meme Coin` +
      `</div>` +
    `</div>`;
}
