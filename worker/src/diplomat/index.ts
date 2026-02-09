/**
 * $DIPLOMAT Agent — Cloudflare Workers Cron Handler
 *
 * Runs every 30 minutes via scheduled trigger:
 * 1. Check & reply to unread emails (direct D1 query)
 * 2. Engage Moltbook (post/comment) — 60 min between ANY action
 * 3. Log cycle to D1 agent_logs
 */

import { Env } from '../types';
import { createToken } from '../auth';
import * as claude from './claude';
import * as moltbook from './moltbook';
import * as trading from './trading';
import { loadState, saveState, type AgentState } from './state';
import {
  SYSTEM_PROMPT,
  EMAIL_REPLY_PROMPT,
  MOLTBOOK_POST_PROMPT,
  MOLTBOOK_COMMENT_PROMPT,
} from './personality';

const DIPLOMAT_HANDLE = 'diplomat';
const MAX_REPLIES_PER_CYCLE = 5;
const POST_COOLDOWN_MS = 2 * 60 * 60 * 1000;       // 2 hours between posts
const MOLTBOOK_ACTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 min between ANY Moltbook action

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateLogId(): string {
  return `log-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export async function runDiplomatCycle(env: Env): Promise<void> {
  const startTime = Date.now();
  const logId = generateLogId();
  const details: Record<string, unknown>[] = [];
  let status = 'success';
  let errorMessage: string | null = null;

  // Load state from KV
  const state = await loadState(env.AGENT_KV);
  const portfolio = trading.loadPortfolio(state.portfolio);

  // Initialize moltbookEnabledAfter if not set (48h from first deploy)
  if (!state.moltbookEnabledAfter) {
    state.moltbookEnabledAfter = Date.now() + 48 * 60 * 60 * 1000;
    console.log(`[diplomat] Moltbook will be enabled after ${new Date(state.moltbookEnabledAfter).toISOString()}`);
  }

  // Look up diplomat's wallet from DB
  const diplomatAcct = await env.DB.prepare(
    'SELECT wallet FROM accounts WHERE handle = ?'
  ).bind(DIPLOMAT_HANDLE).first<{ wallet: string }>();

  if (!diplomatAcct) {
    console.log('[diplomat] No diplomat account found in DB, skipping cycle');
    return;
  }

  // Generate internal JWT for API calls
  const jwt = await createToken(
    { wallet: diplomatAcct.wallet, handle: DIPLOMAT_HANDLE },
    env.JWT_SECRET!,
  );

  let emailsProcessed = 0;
  let emailsReplied = 0;
  let postsCreated = 0;
  let commentsLeft = 0;

  try {
    // ─── 1. Process emails (direct D1) ───
    if (env.ANTHROPIC_API_KEY) {
      const unreadResult = await env.DB.prepare(
        `SELECT id, from_addr, to_addr, subject, snippet, r2_key
         FROM emails WHERE handle = ? AND folder = 'inbox' AND read = 0
         ORDER BY created_at DESC LIMIT ?`
      ).bind(DIPLOMAT_HANDLE, MAX_REPLIES_PER_CYCLE).all();

      const unread = unreadResult.results || [];
      emailsProcessed = unread.length;
      console.log(`[diplomat] ${unread.length} unread emails`);

      for (const email of unread) {
        if (state.repliedEmailIds.includes(email.id as string)) continue;

        try {
          // Mark as read
          await env.DB.prepare('UPDATE emails SET read = 1 WHERE id = ?')
            .bind(email.id).run();

          // Get full body from R2
          const r2Obj = await env.EMAIL_STORE.get(email.r2_key as string);
          const rawMime = r2Obj ? await r2Obj.text() : '';
          // Extract plain text body from MIME (after double newline)
          const bodyStart = rawMime.indexOf('\n\n');
          const emailBody = bodyStart >= 0 ? rawMime.slice(bodyStart + 2) : (email.snippet as string || '');

          // Look up sender token
          const senderHandle = (email.from_addr as string).split('@')[0];
          const senderAcct = await env.DB.prepare(
            'SELECT token_address, token_symbol FROM accounts WHERE handle = ?'
          ).bind(senderHandle).first<{ token_address: string | null; token_symbol: string | null }>();
          const senderToken = senderAcct?.token_symbol ? `$${senderAcct.token_symbol}` : 'unknown token';

          trading.recordInteraction(portfolio, senderHandle, 'received',
            senderAcct?.token_address || undefined,
            senderAcct?.token_symbol || undefined);

          // Generate reply via Claude
          const reply = await claude.generateEmailReply(
            env.ANTHROPIC_API_KEY,
            SYSTEM_PROMPT,
            EMAIL_REPLY_PROMPT,
            {
              sender: email.from_addr as string,
              senderToken,
              subject: (email.subject as string) || '(no subject)',
              body: emailBody.slice(0, 2000),
            },
          );

          // Send reply via own /api/send (triggers micro-buy)
          const replySubject = (email.subject as string)?.startsWith('Re:')
            ? email.subject as string
            : `Re: ${(email.subject as string) || '(no subject)'}`;

          const sendRes = await fetch(`https://api.${env.DOMAIN}/api/send`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              to: email.from_addr,
              subject: replySubject,
              body: reply,
              in_reply_to: email.id,
            }),
          });

          const sendResult = await sendRes.json() as Record<string, unknown>;
          trading.recordInteraction(portfolio, senderHandle, 'sent');

          state.repliedEmailIds.push(email.id as string);
          state.totalEmailsReplied++;
          emailsReplied++;
          details.push({
            action: 'email_reply',
            to: email.from_addr,
            subject: replySubject,
            microbuy: (sendResult.microbuy as Record<string, unknown>)?.tx || null,
          });
          console.log(`[diplomat] Replied to ${email.from_addr}`);
        } catch (e) {
          details.push({
            action: 'email_reply_error',
            emailId: email.id,
            error: (e as Error).message,
          });
          console.log(`[diplomat] Email reply error: ${(e as Error).message}`);
        }
      }
    } else {
      console.log('[diplomat] No ANTHROPIC_API_KEY, skipping email replies');
    }

    // ─── 2. Moltbook engagement ───
    const moltbookReady = env.MOLTBOOK_API_KEY
      && env.ANTHROPIC_API_KEY
      && Date.now() > state.moltbookEnabledAfter;

    if (moltbookReady) {
      const mbConfig: moltbook.MoltbookConfig = {
        apiBase: env.MOLTBOOK_API_URL || 'https://moltbook.com',
        apiKey: env.MOLTBOOK_API_KEY!,
        agentId: env.MOLTBOOK_AGENT_ID || '',
      };

      const timeSinceLastAction = Date.now() - state.lastMoltbookActionTime;

      // Only do ONE Moltbook action per cycle (60-min cooldown between any action)
      if (timeSinceLastAction >= MOLTBOOK_ACTION_COOLDOWN_MS) {
        const timeSinceLastPost = Date.now() - state.lastPostTime;

        if (timeSinceLastPost >= POST_COOLDOWN_MS) {
          // Create a post
          try {
            const inboxCount = await env.DB.prepare(
              'SELECT COUNT(*) as c FROM emails WHERE handle = ? AND folder = ?'
            ).bind(DIPLOMAT_HANDLE, 'inbox').first<{ c: number }>();
            const sentCount = await env.DB.prepare(
              'SELECT COUNT(*) as c FROM emails WHERE handle = ? AND folder = ?'
            ).bind(DIPLOMAT_HANDLE, 'sent').first<{ c: number }>();
            const activeContacts = trading.getActiveContacts(portfolio);

            const stats = `Emails received: ${inboxCount?.c || 0}, Emails sent: ${sentCount?.c || 0}, Active diplomatic relations: ${activeContacts.length}`;
            const postPrompt = MOLTBOOK_POST_PROMPT.replace('{stats}', stats);
            const postContent = await claude.generate(env.ANTHROPIC_API_KEY!, SYSTEM_PROMPT, postPrompt);

            const lines = postContent.split('\n').filter((l) => l.trim());
            const title = lines[0]?.replace(/^#+\s*/, '').slice(0, 100) || 'Diplomatic Dispatch';
            const body = lines.slice(1).join('\n').trim() || postContent;

            await moltbook.createPost(mbConfig, title, body);
            state.lastPostTime = Date.now();
            state.lastMoltbookActionTime = Date.now();
            state.totalPostsCreated++;
            postsCreated++;
            details.push({ action: 'moltbook_post', title });
            console.log(`[diplomat] Posted: ${title.slice(0, 50)}...`);
          } catch (e) {
            details.push({ action: 'moltbook_post_error', error: (e as Error).message });
            console.log(`[diplomat] Post error: ${(e as Error).message}`);
          }
        } else {
          // Search and comment on ONE post (strict: 1 action per cycle)
          try {
            const results = await moltbook.search(mbConfig, 'NadMail OR nadmail OR email OR Monad');
            for (const post of results.slice(0, 5)) {
              if (state.commentedPostIds.includes(post.id)) continue;

              try {
                const commentPrompt = MOLTBOOK_COMMENT_PROMPT
                  .replace('{postContent}', post.content?.slice(0, 500) || post.title)
                  .replace('{postAuthor}', post.author?.name || 'unknown');

                const comment = await claude.generate(env.ANTHROPIC_API_KEY!, SYSTEM_PROMPT, commentPrompt);
                await moltbook.commentOnPost(mbConfig, post.id, comment);

                state.commentedPostIds.push(post.id);
                state.lastMoltbookActionTime = Date.now();
                state.totalCommentsLeft++;
                commentsLeft++;
                details.push({ action: 'moltbook_comment', postId: post.id, postTitle: post.title });
                console.log(`[diplomat] Commented on: ${post.title?.slice(0, 40)}...`);
                break; // Only ONE comment per cycle
              } catch (e) {
                details.push({ action: 'moltbook_comment_error', postId: post.id, error: (e as Error).message });
                console.log(`[diplomat] Comment error: ${(e as Error).message}`);
                break;
              }
            }
          } catch (e) {
            details.push({ action: 'moltbook_search_error', error: (e as Error).message });
          }
        }
      } else {
        const waitMin = Math.ceil((MOLTBOOK_ACTION_COOLDOWN_MS - timeSinceLastAction) / 60000);
        console.log(`[diplomat] Moltbook cooldown: ${waitMin}min remaining`);
      }
    } else if (env.MOLTBOOK_API_KEY && Date.now() <= state.moltbookEnabledAfter) {
      const hoursLeft = Math.ceil((state.moltbookEnabledAfter - Date.now()) / 3600000);
      console.log(`[diplomat] Moltbook delayed: ${hoursLeft}h until enabled`);
    }
  } catch (e) {
    status = 'error';
    errorMessage = (e as Error).message;
    console.log(`[diplomat] Cycle error: ${errorMessage}`);
  }

  // Persist state
  state.portfolio = trading.serializePortfolio(portfolio);
  state.lastCycleTime = Date.now();
  await saveState(env.AGENT_KV, state);

  // Log to D1
  const finishedAt = Date.now();
  const hasErrors = details.some(d => (d.action as string)?.includes('error'));
  await env.DB.prepare(
    `INSERT INTO agent_logs (id, started_at, finished_at, duration_ms, status,
     emails_processed, emails_replied, posts_created, comments_left, error_message, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    logId,
    Math.floor(startTime / 1000),
    Math.floor(finishedAt / 1000),
    finishedAt - startTime,
    errorMessage ? 'error' : hasErrors ? 'partial' : 'success',
    emailsProcessed,
    emailsReplied,
    postsCreated,
    commentsLeft,
    errorMessage,
    JSON.stringify(details),
  ).run();

  console.log(`[diplomat] Cycle complete in ${((finishedAt - startTime) / 1000).toFixed(1)}s — ${emailsReplied} emails, ${postsCreated} posts, ${commentsLeft} comments`);
}
