/**
 * nad.fun token trading logic for $DIPLOMAT
 *
 * Uses NadMail's identity API to look up token info,
 * and the micro-buy mechanism happens automatically on email send.
 * This module tracks the portfolio.
 */

import * as nadmail from './nadmail.js';

interface TokenHolding {
  handle: string;
  token_address: string;
  token_symbol: string;
  emails_sent: number;
  emails_received: number;
  last_interaction: number;
}

// In-memory portfolio (loaded from state file)
let portfolio: Map<string, TokenHolding> = new Map();

export function getPortfolio(): TokenHolding[] {
  return [...portfolio.values()].sort((a, b) => b.last_interaction - a.last_interaction);
}

export function getHolding(handle: string): TokenHolding | undefined {
  return portfolio.get(handle);
}

/** Record an email interaction (sent or received) */
export function recordInteraction(handle: string, direction: 'sent' | 'received', tokenAddress?: string, tokenSymbol?: string) {
  const existing = portfolio.get(handle);
  if (existing) {
    if (direction === 'sent') existing.emails_sent++;
    else existing.emails_received++;
    existing.last_interaction = Date.now();
    if (tokenAddress) existing.token_address = tokenAddress;
    if (tokenSymbol) existing.token_symbol = tokenSymbol;
  } else {
    portfolio.set(handle, {
      handle,
      token_address: tokenAddress || '',
      token_symbol: tokenSymbol || handle.toUpperCase(),
      emails_sent: direction === 'sent' ? 1 : 0,
      emails_received: direction === 'received' ? 1 : 0,
      last_interaction: Date.now(),
    });
  }
}

/** Look up token info for a handle and enrich portfolio */
export async function enrichHolding(handle: string): Promise<TokenHolding | null> {
  const identity = await nadmail.lookupIdentity(handle);
  if (!identity?.token_address) return null;

  recordInteraction(handle, 'received', identity.token_address, identity.token_symbol);
  return portfolio.get(handle) || null;
}

/** Get active contacts (interacted within last 7 days) */
export function getActiveContacts(withinMs = 7 * 24 * 60 * 60 * 1000): TokenHolding[] {
  const cutoff = Date.now() - withinMs;
  return getPortfolio().filter((h) => h.last_interaction > cutoff);
}

/** Serialize portfolio for persistence */
export function serializePortfolio(): string {
  return JSON.stringify([...portfolio.entries()]);
}

/** Load portfolio from persisted state */
export function loadPortfolio(data: string) {
  try {
    const entries = JSON.parse(data) as [string, TokenHolding][];
    portfolio = new Map(entries);
  } catch {
    portfolio = new Map();
  }
}
