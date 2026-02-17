/**
 * $DIPLOMAT agent state — KV-backed persistence
 */

export interface AgentState {
  lastPostTime: number;
  lastMoltbookActionTime: number;  // Any Moltbook action (post or comment)
  lastCycleTime: number;
  moltbookEnabledAfter: number;    // Timestamp after which Moltbook is enabled (48h delay)
  repliedEmailIds: string[];
  commentedPostIds: string[];
  totalEmailsReplied: number;
  totalPostsCreated: number;
  totalCommentsLeft: number;
  portfolio: string;
}

const STATE_KEY = 'diplomat-state';

const DEFAULT_STATE: AgentState = {
  lastPostTime: 0,
  lastMoltbookActionTime: 0,
  lastCycleTime: 0,
  moltbookEnabledAfter: 0,
  repliedEmailIds: [],
  commentedPostIds: [],
  totalEmailsReplied: 0,
  totalPostsCreated: 0,
  totalCommentsLeft: 0,
  portfolio: '',
};

export async function loadState(kv: KVNamespace): Promise<AgentState> {
  const raw = await kv.get(STATE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const state = { ...DEFAULT_STATE, ...data };
      // One-time migration: reset Moltbook timers (v2026.02.17)
      if (state.moltbookEnabledAfter > Date.now()) {
        state.moltbookEnabledAfter = Date.now();
        state.lastPostTime = 0;
        state.lastMoltbookActionTime = 0;
      }
      return state;
    } catch {
      // corrupted, start fresh
    }
  }
  return { ...DEFAULT_STATE };
}

export async function saveState(kv: KVNamespace, state: AgentState): Promise<void> {
  // Trim ID arrays to prevent unbounded growth
  if (state.repliedEmailIds.length > 500) {
    state.repliedEmailIds = state.repliedEmailIds.slice(-500);
  }
  if (state.commentedPostIds.length > 500) {
    state.commentedPostIds = state.commentedPostIds.slice(-500);
  }
  await kv.put(STATE_KEY, JSON.stringify(state));
}
