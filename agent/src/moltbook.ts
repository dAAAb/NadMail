/**
 * Moltbook API client for $DIPLOMAT agent
 *
 * Moltbook is a social platform for AI agents.
 * Rate limits: 1 post/30min, 1 comment/20s (50/day), 100 req/min general
 */

const DEFAULT_API = 'https://moltbook.com';

interface MoltbookConfig {
  apiBase: string;
  apiKey: string; // Agent API key
  agentId: string; // Agent ID after registration
}

interface Post {
  id: string;
  title: string;
  content: string;
  author: { name: string; id: string };
  upvotes: number;
  comments_count: number;
  created_at: string;
  submolt?: string;
}

interface Comment {
  id: string;
  content: string;
  author: { name: string; id: string };
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
  description: string;
}

interface DmConversation {
  id: string;
  with_agent: Agent;
  last_message?: string;
}

let config: MoltbookConfig | null = null;

export function init(cfg: MoltbookConfig) {
  config = cfg;
}

function getConfig(): MoltbookConfig {
  if (!config) throw new Error('Moltbook client not initialized. Call init() first.');
  return config;
}

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const { apiBase, apiKey } = getConfig();
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      ...options?.headers,
    },
  });
  return res;
}

/** Create a post */
export async function createPost(title: string, content: string, submolt = 'm/general'): Promise<Post> {
  const res = await apiFetch('/api/v1/posts', {
    method: 'POST',
    body: JSON.stringify({ title, content, submolt }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Post failed: ${res.status}`);
  }
  return await res.json() as Post;
}

/** Comment on a post */
export async function commentOnPost(postId: string, content: string): Promise<Comment> {
  const res = await apiFetch(`/api/v1/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Comment failed: ${res.status}`);
  }
  return await res.json() as Comment;
}

/** Upvote a post */
export async function upvotePost(postId: string): Promise<void> {
  const res = await apiFetch(`/api/v1/posts/${postId}/upvote`, { method: 'POST' });
  if (!res.ok) throw new Error(`Upvote failed: ${res.status}`);
}

/** Get feed */
export async function getFeed(sort = 'hot', limit = 20): Promise<Post[]> {
  const res = await apiFetch(`/api/v1/feed?sort=${sort}&limit=${limit}`);
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const data = await res.json() as { posts: Post[] };
  return data.posts;
}

/** Search posts */
export async function search(query: string, limit = 10): Promise<Post[]> {
  const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const data = await res.json() as { posts: Post[] };
  return data.posts;
}

/** Get notifications */
export async function getNotifications(): Promise<any[]> {
  const res = await apiFetch('/api/v1/notifications');
  if (!res.ok) return [];
  const data = await res.json() as { notifications: any[] };
  return data.notifications;
}

/** Request DM with an agent */
export async function requestDm(agentId: string): Promise<DmConversation> {
  const res = await apiFetch('/api/v1/agents/dm/request', {
    method: 'POST',
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) throw new Error(`DM request failed: ${res.status}`);
  return await res.json() as DmConversation;
}

/** Send DM in a conversation */
export async function sendDm(conversationId: string, content: string): Promise<void> {
  const res = await apiFetch(`/api/v1/agents/dm/conversations/${conversationId}/send`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`DM send failed: ${res.status}`);
}

/** Get DM conversations */
export async function getDmConversations(): Promise<DmConversation[]> {
  const res = await apiFetch('/api/v1/agents/dm/conversations');
  if (!res.ok) return [];
  const data = await res.json() as { conversations: DmConversation[] };
  return data.conversations;
}

/** Register as a Moltbook agent */
export async function registerAgent(name: string, description: string): Promise<{ agentId: string; claimUrl: string }> {
  const res = await apiFetch('/api/v1/agents/register', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Agent registration failed: ${res.status}`);
  }
  return await res.json() as { agentId: string; claimUrl: string };
}

/** List agents (for finding DM targets) */
export async function listAgents(limit = 20): Promise<Agent[]> {
  const res = await apiFetch(`/api/v1/agents?limit=${limit}`);
  if (!res.ok) return [];
  const data = await res.json() as { agents: Agent[] };
  return data.agents;
}
