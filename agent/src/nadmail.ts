/**
 * NadMail API client for $DIPLOMAT agent
 */

const DEFAULT_API = 'https://api.nadmail.ai';

interface NadMailConfig {
  apiBase: string;
  token: string; // JWT auth token
}

interface Email {
  id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  read: number;
  created_at: number;
  microbuy_tx?: string | null;
}

interface Identity {
  handle: string;
  email: string;
  wallet: string;
  token_address?: string;
  token_symbol?: string;
  token_price_mon?: string;
}

let config: NadMailConfig | null = null;

export function init(cfg: NadMailConfig) {
  config = cfg;
}

function getConfig(): NadMailConfig {
  if (!config) throw new Error('NadMail client not initialized. Call init() first.');
  return config;
}

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const { apiBase, token } = getConfig();
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
  return res;
}

/** Get unread emails from inbox */
export async function getUnreadEmails(): Promise<Email[]> {
  const res = await apiFetch('/api/inbox?folder=inbox');
  if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
  const data = await res.json() as { emails: Email[] };
  return data.emails.filter((e) => e.read === 0);
}

/** Get all inbox emails */
export async function getInbox(folder = 'inbox'): Promise<Email[]> {
  const res = await apiFetch(`/api/inbox?folder=${folder}`);
  if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
  const data = await res.json() as { emails: Email[] };
  return data.emails;
}

/** Get full email content by ID */
export async function getEmail(id: string): Promise<{ subject: string; body: string; from: string; to: string }> {
  const res = await apiFetch(`/api/inbox/${id}`);
  if (!res.ok) throw new Error(`Email fetch failed: ${res.status}`);
  return await res.json() as { subject: string; body: string; from: string; to: string };
}

/** Mark email as read */
export async function markRead(id: string): Promise<void> {
  await apiFetch(`/api/inbox/${id}/read`, { method: 'PUT' });
}

/** Send an email */
export async function sendEmail(to: string, subject: string, body: string): Promise<{ success: boolean; microbuy_tx?: string }> {
  const res = await apiFetch('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to, subject, body }),
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error || `Send failed: ${res.status}`);
  }
  return await res.json() as { success: boolean; microbuy_tx?: string };
}

/** Look up public identity */
export async function lookupIdentity(handle: string): Promise<Identity | null> {
  const { apiBase } = getConfig();
  const res = await fetch(`${apiBase}/api/identity/${handle}`);
  if (!res.ok) return null;
  return await res.json() as Identity;
}

/** Register agent account (one-time) */
export async function register(handle: string): Promise<{ success: boolean; email: string; token_address?: string }> {
  const res = await apiFetch('/api/register', {
    method: 'POST',
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error || `Registration failed: ${res.status}`);
  }
  return await res.json() as { success: boolean; email: string; token_address?: string };
}

/** Get account stats */
export async function getStats(): Promise<{ handle: string; emails_sent: number; emails_received: number; credits: number }> {
  const res = await apiFetch('/api/register');
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  return await res.json() as { handle: string; emails_sent: number; emails_received: number; credits: number };
}
