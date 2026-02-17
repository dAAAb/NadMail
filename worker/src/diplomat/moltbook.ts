/**
 * Moltbook API client — config-as-param pattern (no module state)
 *
 * Rate limits (STRICT — accounts get banned!):
 * - All Moltbook actions (post + comment) must be >= 60 min apart
 * - General: 100 req/min
 */

export interface MoltbookConfig {
  apiBase: string;
  apiKey: string;
  agentId: string;
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

async function apiFetch(config: MoltbookConfig, path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      ...options?.headers,
    },
  });
}

export async function createPost(config: MoltbookConfig, title: string, content: string, submolt_name = 'general'): Promise<Post> {
  const res = await apiFetch(config, '/api/v1/posts', {
    method: 'POST',
    body: JSON.stringify({ title, content, submolt_name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; message?: string | string[] };
    const msg = Array.isArray(err.message) ? err.message.join(', ') : (err.message || err.error || `Post failed: ${res.status}`);
    throw new Error(msg);
  }
  const data = await res.json() as any;
  // Handle verification challenge (Moltbook anti-spam)
  if (data.post?.verification?.challenge_text) {
    try {
      const challenge = data.post.verification.challenge_text;
      const code = data.post.verification.verification_code;
      // Extract numbers and operation from the obfuscated challenge
      const nums = challenge.match(/[\d.]+/g)?.map(Number) || [];
      const hasAdd = /aDd|pLuS|ToTaL/i.test(challenge);
      const hasSub = /sUbTrAcT|mInUs|dIfFeReNcE/i.test(challenge);
      const hasMul = /mUlTiPl|tImEs|pRoDuCt/i.test(challenge);
      const hasDiv = /dIvId|qUoTiEnT/i.test(challenge);
      let answer = 0;
      if (nums.length >= 2) {
        if (hasMul) answer = nums[0] * nums[1];
        else if (hasDiv) answer = nums[0] / nums[1];
        else if (hasSub) answer = nums[0] - nums[1];
        else answer = nums[0] + nums[1]; // default add
      }
      await apiFetch(config, '/api/v1/verify', {
        method: 'POST',
        body: JSON.stringify({ verification_code: code, answer: answer.toFixed(2) }),
      });
    } catch (e) {
      console.log(`[moltbook] Verification failed: ${(e as Error).message}`);
    }
  }
  return data.post || data;
}

export async function commentOnPost(config: MoltbookConfig, postId: string, content: string): Promise<Comment> {
  const res = await apiFetch(config, `/api/v1/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Comment failed: ${res.status}`);
  }
  return await res.json() as Comment;
}

export async function upvotePost(config: MoltbookConfig, postId: string): Promise<void> {
  const res = await apiFetch(config, `/api/v1/posts/${postId}/upvote`, { method: 'POST' });
  if (!res.ok) throw new Error(`Upvote failed: ${res.status}`);
}

export async function search(config: MoltbookConfig, query: string, limit = 10): Promise<Post[]> {
  const res = await apiFetch(config, `/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const data = await res.json() as { posts: Post[] };
  return data.posts;
}
