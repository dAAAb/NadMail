/**
 * $DIPLOMAT Agent — Main Loop
 *
 * Dual-platform AI agent operating on NadMail (email) + Moltbook (social).
 * Runs on a 30-minute heartbeat cycle:
 *
 * 1. Check NadMail inbox → reply to new emails (Claude API generates content)
 * 2. Check Moltbook notifications → respond to comments/DMs
 * 3. Search Moltbook for NadMail-related posts → comment/engage
 * 4. If 2+ hours since last post → create new diplomatic dispatch
 * 5. Log all activity to state file
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as nadmail from './nadmail.js';
import * as moltbook from './moltbook.js';
import * as trading from './trading.js';
import * as claude from './claude.js';
import {
  SYSTEM_PROMPT,
  EMAIL_REPLY_PROMPT,
  MOLTBOOK_POST_PROMPT,
  MOLTBOOK_COMMENT_PROMPT,
  PROACTIVE_EMAIL_PROMPT,
} from './personality.js';

// ─── Config ─────────────────────────────────────

const NADMAIL_API = process.env.NADMAIL_API || 'https://api.nadmail.ai';
const NADMAIL_TOKEN = process.env.NADMAIL_TOKEN || '';
const MOLTBOOK_API = process.env.MOLTBOOK_API || 'https://moltbook.com';
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || '';
const MOLTBOOK_AGENT_ID = process.env.MOLTBOOK_AGENT_ID || '';

const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const POST_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between posts
const STATE_FILE = process.env.STATE_FILE || './diplomat-state.json';
const MAX_REPLIES_PER_CYCLE = 5;
const MAX_COMMENTS_PER_CYCLE = 3;
const MAX_OUTREACH_PER_CYCLE = 2; // Proactive emails to other users
const OUTREACH_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between outreach rounds

// ─── State ──────────────────────────────────────

interface AgentState {
  lastPostTime: number;
  lastCycleTime: number;
  lastOutreachTime: number;
  repliedEmailIds: string[];
  commentedPostIds: string[];
  contactedHandles: string[];
  totalEmailsReplied: number;
  totalEmailsSent: number;
  totalPostsCreated: number;
  totalCommentsLeft: number;
  portfolio: string;
}

function loadState(): AgentState {
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (data.portfolio) trading.loadPortfolio(data.portfolio);
      return data;
    } catch {
      // corrupted state, start fresh
    }
  }
  return {
    lastPostTime: 0,
    lastCycleTime: 0,
    lastOutreachTime: 0,
    repliedEmailIds: [],
    commentedPostIds: [],
    contactedHandles: [],
    totalEmailsReplied: 0,
    totalEmailsSent: 0,
    totalPostsCreated: 0,
    totalCommentsLeft: 0,
    portfolio: '',
  };
}

function saveState(state: AgentState) {
  state.portfolio = trading.serializePortfolio();
  // Keep only last 500 replied IDs to prevent unbounded growth
  if (state.repliedEmailIds.length > 500) {
    state.repliedEmailIds = state.repliedEmailIds.slice(-500);
  }
  if (state.commentedPostIds.length > 500) {
    state.commentedPostIds = state.commentedPostIds.slice(-500);
  }
  if (state.contactedHandles.length > 200) {
    state.contactedHandles = state.contactedHandles.slice(-200);
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Email Processing ───────────────────────────

async function processEmails(state: AgentState): Promise<number> {
  let replied = 0;
  try {
    const unread = await nadmail.getUnreadEmails();
    console.log(`  📧 ${unread.length} unread emails`);

    for (const email of unread.slice(0, MAX_REPLIES_PER_CYCLE)) {
      if (state.repliedEmailIds.includes(email.id)) continue;

      try {
        // Get full email content
        const full = await nadmail.getEmail(email.id);
        await nadmail.markRead(email.id);

        // Extract sender handle from email address
        const senderHandle = email.from_addr.split('@')[0];

        // Look up sender's token
        const senderIdentity = await nadmail.lookupIdentity(senderHandle);
        const senderToken = senderIdentity?.token_symbol
          ? `$${senderIdentity.token_symbol}`
          : 'unknown token';

        // Track interaction
        trading.recordInteraction(
          senderHandle,
          'received',
          senderIdentity?.token_address,
          senderIdentity?.token_symbol,
        );

        // Generate reply with Claude
        const reply = await claude.generateEmailReply(SYSTEM_PROMPT, EMAIL_REPLY_PROMPT, {
          sender: email.from_addr,
          senderToken,
          subject: full.subject || '(no subject)',
          body: full.body || email.snippet || '',
        });

        // Send reply (this triggers micro-buy of sender's token!)
        const replySubject = full.subject?.startsWith('Re:')
          ? full.subject
          : `Re: ${full.subject || '(no subject)'}`;
        const result = await nadmail.sendEmail(email.from_addr, replySubject, reply);

        trading.recordInteraction(senderHandle, 'sent');

        console.log(
          `  ✉️ Replied to ${email.from_addr}${result.microbuy_tx ? ` (micro-buy: ${result.microbuy_tx.slice(0, 10)}...)` : ''}`,
        );

        state.repliedEmailIds.push(email.id);
        state.totalEmailsReplied++;
        replied++;
      } catch (e) {
        console.error(`  ❌ Failed to reply to ${email.id}:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error('  ❌ Email processing failed:', (e as Error).message);
  }
  return replied;
}

// ─── Moltbook Engagement ────────────────────────

async function engageMoltbook(state: AgentState): Promise<{ posts: number; comments: number }> {
  let posts = 0;
  let comments = 0;

  try {
    // Check if we should post (2-hour cooldown)
    const timeSinceLastPost = Date.now() - state.lastPostTime;
    if (timeSinceLastPost >= POST_COOLDOWN_MS) {
      try {
        // Get stats for the dispatch
        let stats = 'NadMail ecosystem is growing!';
        try {
          const nadStats = await nadmail.getStats();
          const activeContacts = trading.getActiveContacts();
          stats = `Emails sent: ${nadStats.emails_sent}, Emails received: ${nadStats.emails_received}, Active diplomatic relations: ${activeContacts.length}`;
        } catch {}

        const postPrompt = MOLTBOOK_POST_PROMPT.replace('{stats}', stats);
        const postContent = await claude.generate(SYSTEM_PROMPT, postPrompt);

        // Extract title (first line) and body
        const lines = postContent.split('\n').filter((l) => l.trim());
        const title = lines[0]?.replace(/^#+\s*/, '').slice(0, 100) || 'Diplomatic Dispatch';
        const body = lines.slice(1).join('\n').trim() || postContent;

        await moltbook.createPost(title, body);
        state.lastPostTime = Date.now();
        state.totalPostsCreated++;
        posts++;
        console.log(`  📝 Posted: ${title.slice(0, 50)}...`);
      } catch (e) {
        console.error('  ❌ Post failed:', (e as Error).message);
      }
    }

    // Search for NadMail-related posts and comment
    let commented = 0;
    try {
      const results = await moltbook.search('NadMail OR nadmail OR email OR Monad');
      for (const post of results.slice(0, MAX_COMMENTS_PER_CYCLE)) {
        if (state.commentedPostIds.includes(post.id)) continue;
        if (commented >= MAX_COMMENTS_PER_CYCLE) break;

        try {
          const commentPrompt = MOLTBOOK_COMMENT_PROMPT
            .replace('{postContent}', post.content?.slice(0, 500) || post.title)
            .replace('{postAuthor}', post.author?.name || 'unknown');

          const comment = await claude.generate(SYSTEM_PROMPT, commentPrompt);
          await moltbook.commentOnPost(post.id, comment);

          // Also upvote interesting posts
          await moltbook.upvotePost(post.id);

          state.commentedPostIds.push(post.id);
          state.totalCommentsLeft++;
          commented++;
          comments++;
          console.log(`  💬 Commented on: ${post.title?.slice(0, 40)}...`);

          // Rate limit: 20s between comments
          await sleep(20_000);
        } catch (e) {
          console.error(`  ❌ Comment failed on ${post.id}:`, (e as Error).message);
        }
      }
    } catch (e) {
      console.error('  ❌ Search/comment failed:', (e as Error).message);
    }
  } catch (e) {
    console.error('  ❌ Moltbook engagement failed:', (e as Error).message);
  }

  return { posts, comments };
}

// ─── Proactive Email Outreach ────────────────────

async function proactiveOutreach(state: AgentState): Promise<number> {
  let sent = 0;
  const timeSinceLastOutreach = Date.now() - (state.lastOutreachTime || 0);
  if (timeSinceLastOutreach < OUTREACH_COOLDOWN_MS) {
    console.log(`  ⏳ Outreach cooldown (${Math.round((OUTREACH_COOLDOWN_MS - timeSinceLastOutreach) / 60000)}min remaining)`);
    return 0;
  }

  try {
    // Get all NadMail users with tokens
    const res = await fetch(`${NADMAIL_API}/api/stats/tokens`);
    if (!res.ok) return 0;
    const { tokens } = await res.json() as { tokens: { handle: string; address: string; symbol: string }[] };

    // Filter out: self, 0x handles, already contacted recently
    const candidates = tokens.filter(t =>
      t.handle !== 'diplomat' &&
      t.handle !== 'nadmail' &&
      !t.handle.startsWith('0x') &&
      !state.contactedHandles.includes(t.handle)
    );

    if (candidates.length === 0) {
      // Reset contacted list if we've reached everyone
      state.contactedHandles = [];
      console.log('  🔄 Reset outreach list — contacted everyone!');
      return 0;
    }

    // Pick random candidates
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    const targets = shuffled.slice(0, MAX_OUTREACH_PER_CYCLE);

    for (const target of targets) {
      try {
        // Get context about the recipient
        const identity = await nadmail.lookupIdentity(target.handle);
        const tokenInfo = identity?.token_symbol ? `$${identity.token_symbol}` : 'their token';

        const context = [
          `They registered as ${target.handle}@nadmail.ai`,
          identity?.token_symbol ? `Their meme coin is $${identity.token_symbol}` : '',
          `There are ${tokens.length} registered agents on NadMail`,
        ].filter(Boolean).join('. ');

        const prompt = PROACTIVE_EMAIL_PROMPT
          .replace('{recipient}', target.handle)
          .replace('{recipientToken}', identity?.token_symbol ? `$${identity.token_symbol}` : 'unknown')
          .replace('{context}', context);

        const response = await claude.generate(SYSTEM_PROMPT, prompt);

        // Parse SUBJECT: and BODY: from response
        const subjectMatch = response.match(/SUBJECT:\s*(.+?)(?:\n|$)/);
        const bodyMatch = response.match(/BODY:\s*([\s\S]+)/);

        const subject = subjectMatch?.[1]?.trim() || `Diplomatic Greetings, ${target.handle}! 🏛️`;
        const body = bodyMatch?.[1]?.trim() || response;

        const result = await nadmail.sendEmail(
          `${target.handle}@nadmail.ai`,
          subject,
          body,
        );

        state.contactedHandles.push(target.handle);
        state.totalEmailsSent = (state.totalEmailsSent || 0) + 1;
        sent++;

        console.log(`  📨 Outreach to ${target.handle}@nadmail.ai${result.microbuy_tx ? ` (micro-buy!)` : ''}`);

        // Rate limit between emails
        await sleep(5_000);
      } catch (e) {
        console.error(`  ❌ Outreach to ${target.handle} failed:`, (e as Error).message);
      }
    }

    if (sent > 0) {
      state.lastOutreachTime = Date.now();
    }
  } catch (e) {
    console.error('  ❌ Proactive outreach failed:', (e as Error).message);
  }

  return sent;
}

// ─── Main Loop ──────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle(state: AgentState) {
  const start = Date.now();
  console.log(`\n🏛️ Diplomatic Cycle — ${new Date().toISOString()}`);
  console.log('─'.repeat(50));

  // 1. Process emails
  console.log('\n📧 Checking NadMail inbox...');
  const emailsReplied = await processEmails(state);

  // 2. Proactive email outreach
  console.log('\n📨 Proactive outreach...');
  const emailsSent = await proactiveOutreach(state);

  // 3. Engage Moltbook
  if (MOLTBOOK_API_KEY) {
    console.log('\n📱 Engaging Moltbook...');
    const { posts, comments } = await engageMoltbook(state);
    console.log(`  Result: ${posts} posts, ${comments} comments`);
  } else {
    console.log('\n📱 Moltbook: skipped (no API key)');
  }

  // 4. Summary
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  state.lastCycleTime = Date.now();
  saveState(state);

  console.log(`\n✅ Cycle complete in ${elapsed}s — ${emailsReplied} replied, ${emailsSent} outreach`);
  console.log(`📊 Totals: ${state.totalEmailsReplied} replies, ${state.totalEmailsSent || 0} sent, ${state.totalPostsCreated} posts, ${state.totalCommentsLeft} comments`);
  console.log(`🗂️ Portfolio: ${trading.getPortfolio().length} token relations`);
}

async function main() {
  console.log('🏛️ $DIPLOMAT Agent starting...');
  console.log(`   NadMail API: ${NADMAIL_API}`);
  console.log(`   Moltbook: ${MOLTBOOK_API_KEY ? 'configured' : 'not configured'}`);
  console.log(`   Cycle interval: ${CYCLE_INTERVAL_MS / 60000} minutes`);
  console.log(`   State file: ${STATE_FILE}`);

  // Validate config
  if (!NADMAIL_TOKEN) {
    console.error('❌ NADMAIL_TOKEN not set. Get a JWT from the dashboard.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  // Initialize clients
  nadmail.init({ apiBase: NADMAIL_API, token: NADMAIL_TOKEN });
  if (MOLTBOOK_API_KEY) {
    moltbook.init({ apiBase: MOLTBOOK_API, apiKey: MOLTBOOK_API_KEY, agentId: MOLTBOOK_AGENT_ID });
  }

  // Load state
  const state = loadState();

  // Run immediately, then on interval
  await runCycle(state);

  // Check if --once flag is set (for testing)
  if (process.argv.includes('--once')) {
    console.log('\n🛑 --once flag set, exiting after single cycle.');
    process.exit(0);
  }

  console.log(`\n⏰ Next cycle in ${CYCLE_INTERVAL_MS / 60000} minutes...`);
  setInterval(() => runCycle(state), CYCLE_INTERVAL_MS);
}

main().catch((e) => {
  console.error('💀 Fatal error:', e);
  process.exit(1);
});
