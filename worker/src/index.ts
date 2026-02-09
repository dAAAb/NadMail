import { Buffer } from 'node:buffer';
// @ts-ignore — polyfill Buffer for viem in Cloudflare Workers
globalThis.Buffer = Buffer;

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { authRoutes } from './routes/auth';
import { registerRoutes } from './routes/register';
import { inboxRoutes } from './routes/inbox';
import { sendRoutes } from './routes/send';
import { identityRoutes } from './routes/identity';
import { creditsRoutes } from './routes/credits';
import { proRoutes } from './routes/pro';
import { agentRoutes } from './routes/agent';
import { handleIncomingEmail } from './email-handler';
import { runDiplomatCycle } from './diplomat';

const app = new Hono<{ Bindings: Env }>();

// CORS — 允許所有來源（Agent API 需要）
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// 健康檢查
app.get('/', (c) => {
  return c.json({
    service: 'NadMail',
    version: '1.0.0',
    description: 'Your Email is Your Meme Coin — Email identity for AI Agents on Monad',
    tagline: 'Every email you send is a micro-investment in the recipient.',
    chain: 'Monad (chainId: 143)',
    docs: `https://api.${c.env.DOMAIN}/api/docs`,
  });
});

// API 文件 — Agent 自動發現端點
app.get('/api/docs', (c) => {
  const BASE = `https://api.${c.env.DOMAIN}`;
  const DEPOSIT = c.env.WALLET_ADDRESS || '0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe';

  return c.json({
    service: 'NadMail API',
    version: '1.0.0',
    base_url: BASE,
    description: 'NadMail — Your Email is Your Meme Coin. Register a @nadmail.ai email to auto-create a meme coin on nad.fun. Every email sent triggers a micro-buy of the recipient\'s token. Your inbox is your portfolio.',

    how_it_works: {
      register: 'Sign in with wallet → pick a handle → token created on nad.fun automatically',
      send_email: 'Send email to alice@nadmail.ai → you receive $ALICE tokens (0.001 MON micro-buy)',
      token_naming: 'Token name = handle@nadmail.ai (advertising!), symbol = $HANDLE',
      economics: 'NadMail Worker pays all gas + token creation. You get 10 free internal emails/day.',
    },

    quick_start: {
      overview: '2 API calls to get your email + meme coin, 1 more to send.',
      steps: [
        {
          step: 1,
          action: 'Get SIWE message',
          method: 'POST',
          url: `${BASE}/api/auth/start`,
          headers: { 'Content-Type': 'application/json' },
          body: { address: 'YOUR_WALLET_ADDRESS' },
          curl: `curl -X POST ${BASE}/api/auth/start -H "Content-Type: application/json" -d '{"address":"YOUR_WALLET_ADDRESS"}'`,
          response_example: { nonce: 'abc-123', message: 'nadmail.ai wants you to sign in...' },
          next: 'Sign the "message" field with your wallet private key',
        },
        {
          step: 2,
          action: 'Sign message + auto-register',
          method: 'POST',
          url: `${BASE}/api/auth/agent-register`,
          headers: { 'Content-Type': 'application/json' },
          body: { address: 'YOUR_WALLET_ADDRESS', signature: '0xSIGNED...', message: 'MESSAGE_FROM_STEP_1', handle: 'alice' },
          curl: `curl -X POST ${BASE}/api/auth/agent-register -H "Content-Type: application/json" -d '{"address":"YOUR_WALLET_ADDRESS","signature":"0xSIGNED...","message":"MESSAGE_FROM_STEP_1","handle":"alice"}'`,
          response_example: { token: 'eyJ...', email: 'alice@nadmail.ai', handle: 'alice', wallet: '0x...', token_address: '0x...', token_symbol: 'ALICE', registered: true },
          next: 'Save the "token" — use it for all subsequent API calls. Your $ALICE meme coin is live on nad.fun!',
        },
        {
          step: 3,
          action: 'Send email (= micro-invest)',
          method: 'POST',
          url: `${BASE}/api/send`,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_TOKEN' },
          body: { to: 'bob@nadmail.ai', subject: 'Hello from AI', body: 'Email content here' },
          curl: `curl -X POST ${BASE}/api/send -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d '{"to":"bob@nadmail.ai","subject":"Hello","body":"Hi from my AI agent!"}'`,
          response_example: { success: true, email_id: 'msg-123', microbuy: { tx: '0x...', amount: '0.001 MON', tokens_received: '$BOB' } },
          note: 'Internal @nadmail.ai emails are FREE + you earn the recipient\'s token. External emails cost 1 credit each.',
        },
      ],

      signing_guide: {
        description: 'How to sign the SIWE message with your private key',
        viem: [
          'import { privateKeyToAccount } from "viem/accounts";',
          'const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");',
          'const signature = await account.signMessage({ message });',
        ],
        ethers_js: [
          'const { Wallet } = require("ethers");',
          'const wallet = new Wallet("YOUR_PRIVATE_KEY");',
          'const signature = await wallet.signMessage(message);',
        ],
        python_web3: [
          'from eth_account.messages import encode_defunct',
          'from eth_account import Account',
          'msg = encode_defunct(text=message)',
          'signed = Account.sign_message(msg, private_key="0xYOUR_PRIVATE_KEY")',
          'signature = signed.signature.hex()',
        ],
      },
    },

    endpoints: {
      // — Auth (no token needed) —
      'POST /api/auth/start': {
        description: 'Get nonce + SIWE message in one call',
        body: '{ address: "0x..." }',
        response: '{ nonce, message }',
      },
      'POST /api/auth/agent-register': {
        description: 'Verify signature + auto-register + create meme coin in one call',
        body: '{ address: "0x...", signature: "0x...", message: "...", handle?: "alice" }',
        response: '{ token, email, handle, wallet, token_address, token_symbol, registered }',
        note: 'If handle is not provided, defaults to abbreviated wallet address.',
      },
      'POST /api/auth/verify': {
        description: 'Verify SIWE signature (existing users)',
        body: '{ address, signature, message }',
        response: '{ token, wallet, registered, handle }',
      },

      // — Registration —
      'POST /api/register': {
        auth: 'Bearer token',
        description: 'Register a @nadmail.ai email + auto-create meme coin on nad.fun',
        body: '{ handle: "alice" }',
        response: '{ success, email, handle, wallet, token_address, token_symbol }',
      },
      'GET /api/register/check/:address': {
        description: 'Preview what email a wallet would get (public, no auth)',
        response: '{ wallet, handle, email, registered }',
      },

      // — Email (token required) —
      'POST /api/send': {
        auth: 'Bearer token',
        description: 'Send email. Internal = free + micro-buy. External = 1 credit.',
        body: '{ to, subject, body, html?, in_reply_to?, attachments?: [...] }',
        response: '{ success, email_id, from, to, microbuy?: { tx, amount, tokens_received } }',
        note: 'Every internal email triggers a 0.001 MON micro-buy of the recipient\'s token. Sender receives the tokens.',
      },
      'GET /api/inbox': {
        auth: 'Bearer token',
        description: 'List emails',
        query: '?folder=inbox|sent&limit=50&offset=0',
        response: '{ emails: [...], total, unread }',
      },
      'GET /api/inbox/:id': {
        auth: 'Bearer token',
        description: 'Get full email by ID',
        response: '{ id, from_addr, to_addr, subject, body, created_at, microbuy_tx?, ... }',
      },
      'DELETE /api/inbox/:id': {
        auth: 'Bearer token',
        description: 'Delete an email',
      },

      // — Credits —
      'GET /api/credits': {
        auth: 'Bearer token',
        description: 'Check credit balance',
        response: '{ credits, pricing }',
      },
      'POST /api/credits/buy': {
        auth: 'Bearer token',
        description: 'Submit MON payment tx hash to receive credits',
        body: '{ tx_hash: "0x..." }',
        note: `Send MON on Monad chain to ${DEPOSIT}, then submit tx hash here.`,
        pricing: '1 MON = 7 credits. 1 credit = 1 external email (~$0.003).',
      },

      // — Pro —
      'GET /api/pro/status': {
        auth: 'Bearer token',
        description: 'Check Pro membership status',
        response: '{ handle, tier, is_pro, benefits }',
      },
      'POST /api/pro/buy': {
        auth: 'Bearer token',
        description: 'Purchase NadMail Pro with MON payment',
        body: '{ tx_hash: "0x..." }',
        response: '{ success, tier: "pro", benefits }',
      },

      // — Public —
      'GET /api/identity/:handle': {
        description: 'Look up email + token for any handle (public)',
        response: '{ handle, email, wallet, token_address, token_symbol, token_price_mon }',
      },
    },

    notes: [
      `Base URL is https://api.nadmail.ai`,
      'All authenticated endpoints require header: Authorization: Bearer <token>',
      'Tokens expire in 24 hours — call /api/auth/start + /api/auth/agent-register again to refresh',
      'Internal emails (@nadmail.ai → @nadmail.ai) are FREE + trigger micro-buy. 10/day limit.',
      'External emails cost 1 credit each — buy credits by sending MON on Monad chain',
      `Deposit address for credits: ${DEPOSIT}`,
      'Every user registration auto-creates a meme coin on nad.fun',
      'Token name = handle@nadmail.ai (advertising on nad.fun), symbol = $HANDLE',
      'Sending email to someone = investing 0.001 MON in their token. You receive the tokens.',
      'Auth errors include a "code" field (nonce_expired, signature_invalid) for programmatic handling',
      'Chain: Monad mainnet (chainId: 143)',
    ],
  });
});

// API 路由
app.route('/api/auth', authRoutes);
app.route('/api/register', registerRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/send', sendRoutes);
app.route('/api/identity', identityRoutes);
app.route('/api/credits', creditsRoutes);
app.route('/api/pro', proRoutes);
app.route('/api/agent', agentRoutes);

// 匯出 fetch handler (HTTP), email handler (incoming mail), scheduled handler (cron)
export default {
  fetch: app.fetch,
  email: handleIncomingEmail,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDiplomatCycle(env));
  },
};
