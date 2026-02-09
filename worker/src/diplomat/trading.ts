/**
 * Token portfolio tracking — all state passed as params (no module-level state)
 */

export interface TokenHolding {
  handle: string;
  token_address: string;
  token_symbol: string;
  emails_sent: number;
  emails_received: number;
  last_interaction: number;
}

export function loadPortfolio(data: string): Map<string, TokenHolding> {
  try {
    const entries = JSON.parse(data) as [string, TokenHolding][];
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export function serializePortfolio(portfolio: Map<string, TokenHolding>): string {
  return JSON.stringify([...portfolio.entries()]);
}

export function recordInteraction(
  portfolio: Map<string, TokenHolding>,
  handle: string,
  direction: 'sent' | 'received',
  tokenAddress?: string,
  tokenSymbol?: string,
): void {
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

export function getActiveContacts(
  portfolio: Map<string, TokenHolding>,
  withinMs = 7 * 24 * 60 * 60 * 1000,
): TokenHolding[] {
  const cutoff = Date.now() - withinMs;
  return [...portfolio.values()]
    .filter((h) => h.last_interaction > cutoff)
    .sort((a, b) => b.last_interaction - a.last_interaction);
}
