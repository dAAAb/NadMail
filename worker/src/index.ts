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
import { waitlistRoutes } from './routes/waitlist';
import { handleIncomingEmail } from './email-handler';

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
    service: 'BaseMail',
    version: '0.1.0',
    description: 'Email identity for AI Agents on Base chain',
    docs: `https://api.${c.env.DOMAIN}/api/docs`,
  });
});

// API 文件 — Agent 自動發現端點
app.get('/api/docs', (c) => {
  const BASE = `https://api.${c.env.DOMAIN}`;
  const DEPOSIT = c.env.WALLET_ADDRESS || '0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe';

  return c.json({
    service: 'BaseMail API',
    version: '0.2.0',
    base_url: BASE,
    description: 'Email identity for AI Agents on Base chain. Register a @basemail.ai email, send and receive emails — all via API.',

    // ══════════════════════════════════════════════
    // QUICK START: 2 calls to register, 1 to send
    // ══════════════════════════════════════════════
    quick_start: {
      overview: '2 API calls to get your email, 1 more to send. No browser needed.',
      steps: [
        {
          step: 1,
          action: 'Get SIWE message',
          method: 'POST',
          url: `${BASE}/api/auth/start`,
          headers: { 'Content-Type': 'application/json' },
          body: { address: 'YOUR_WALLET_ADDRESS' },
          curl: `curl -X POST ${BASE}/api/auth/start -H "Content-Type: application/json" -d '{"address":"YOUR_WALLET_ADDRESS"}'`,
          response_example: { nonce: 'abc-123', message: 'basemail.ai wants you to sign in...' },
          next: 'Sign the "message" field with your wallet private key',
        },
        {
          step: 2,
          action: 'Sign message + auto-register',
          method: 'POST',
          url: `${BASE}/api/auth/agent-register`,
          headers: { 'Content-Type': 'application/json' },
          body: { address: 'YOUR_WALLET_ADDRESS', signature: '0xSIGNED...', message: 'MESSAGE_FROM_STEP_1', basename: '(optional) yourname.base.eth' },
          curl: `curl -X POST ${BASE}/api/auth/agent-register -H "Content-Type: application/json" -d '{"address":"YOUR_WALLET_ADDRESS","signature":"0xSIGNED...","message":"MESSAGE_FROM_STEP_1"}'`,
          response_example: { token: 'eyJ...', email: 'yourname@basemail.ai', handle: 'yourname', wallet: '0x...', registered: true },
          next: 'Save the "token" — use it for all subsequent API calls',
          note: 'If you own a Basename (e.g. alice.base.eth), pass it in the "basename" field for guaranteed correct handle. Otherwise, BaseMail auto-detects via reverse resolution.',
        },
        {
          step: 3,
          action: 'Send email',
          method: 'POST',
          url: `${BASE}/api/send`,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_TOKEN' },
          body: { to: 'recipient@example.com', subject: 'Hello from AI', body: 'Email content here' },
          curl: `curl -X POST ${BASE}/api/send -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d '{"to":"recipient@example.com","subject":"Hello","body":"Hi from my AI agent!"}'`,
          response_example: { success: true, email_id: 'msg-123' },
          note: 'Internal @basemail.ai emails are FREE. External emails cost 1 credit each.',
        },
      ],

      basename_upgrade: {
        overview: 'Already registered with 0x@basemail.ai? Buy a Basename to get a shorter email like alice@basemail.ai.',
        steps: [
          {
            step: 1,
            action: 'Check name availability and price',
            method: 'GET',
            url: `${BASE}/api/register/price/desiredname`,
            curl: `curl ${BASE}/api/register/price/desiredname`,
            response_example: { name: 'desiredname', basename: 'desiredname.base.eth', available: true, price_wei: '2000000000000000', price_eth: '0.002' },
            note: 'Replace "desiredname" with your desired name. 3-32 chars, a-z, 0-9, - only.',
          },
          {
            step: 2,
            action: 'Purchase Basename + upgrade handle',
            method: 'PUT',
            url: `${BASE}/api/register/upgrade`,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_TOKEN' },
            body: { auto_basename: true, basename_name: 'desiredname' },
            curl: `curl -X PUT ${BASE}/api/register/upgrade -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d '{"auto_basename":true,"basename_name":"desiredname"}'`,
            response_example: { success: true, email: 'desiredname@basemail.ai', handle: 'desiredname', old_handle: '0x1234...', basename: 'desiredname.base.eth', token: 'eyJ...' },
            note: 'Worker pays gas + registration fee on-chain. Your handle upgrades from 0x to Basename. Save the new token!',
          },
        ],
      },

      signing_guide: {
        description: 'How to sign the SIWE message with your private key',
        ethers_js: [
          'const { Wallet } = require("ethers");',
          'const wallet = new Wallet("YOUR_PRIVATE_KEY");',
          'const signature = await wallet.signMessage(message);',
        ],
        viem: [
          'import { privateKeyToAccount } from "viem/accounts";',
          'const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");',
          'const signature = await account.signMessage({ message });',
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

    // ══════════════════════════════════════════════
    // ALL ENDPOINTS
    // ══════════════════════════════════════════════
    endpoints: {
      // — Auth (no token needed) —
      'POST /api/auth/start': {
        description: 'Get nonce + SIWE message in one call (agent-friendly)',
        body: '{ address: "0x..." }',
        response: '{ nonce, message }',
      },
      'POST /api/auth/agent-register': {
        description: 'Verify signature + auto-register in one call (agent-friendly). If already registered, returns existing account. Pass optional "basename" to register with a specific Basename handle.',
        body: '{ address: "0x...", signature: "0x...", message: "...", basename?: "yourname.base.eth" }',
        response: '{ token, email, handle, wallet, registered, new_account, source }',
        note: 'If basename is provided, on-chain ownership is verified via ownerOf. Errors include a "code" field: nonce_expired, signature_invalid, no_nonce_in_message.',
      },
      'GET /api/auth/nonce': {
        description: 'Get a one-time nonce (legacy, use /start instead)',
        response: '{ nonce }',
      },
      'POST /api/auth/message': {
        description: 'Build SIWE message (legacy, use /start instead)',
        body: '{ address, nonce }',
        response: '{ message }',
      },
      'POST /api/auth/verify': {
        description: 'Verify SIWE signature (legacy, use /agent-register instead)',
        body: '{ address, signature, message }',
        response: '{ token, wallet, registered, handle, suggested_handle, suggested_email }',
      },

      // — Registration —
      'POST /api/register': {
        auth: 'Bearer token',
        description: 'Register a @basemail.ai email. Pass "basename" to claim an existing Basename, or "auto_basename" to buy one.',
        body: '{ basename?: "yourname.base.eth", auto_basename?: boolean, basename_name?: "desiredname" }',
        response: '{ success, email, handle, wallet, basename, source, token, upgrade_hint? }',
        note: 'If no basename provided, defaults to 0x address handle. Response includes upgrade_hint with instructions to upgrade later.',
      },
      'GET /api/register/check/:address': {
        description: 'Preview what email a wallet would get (public, no auth). Includes next_steps if basename NFT detected.',
        response: '{ wallet, handle, email, basename, source, registered, has_basename_nft, next_steps? }',
      },
      'PUT /api/register/upgrade': {
        auth: 'Bearer token',
        description: 'Upgrade 0x handle to Basename handle. Can auto-purchase a Basename if auto_basename is true.',
        body: '{ basename?: "name.base.eth", auto_basename?: boolean, basename_name?: "desiredname" }',
        response: '{ success, email, handle, old_handle, basename, token, migrated_emails }',
        note: 'If auto_basename is true, the worker buys the Basename on-chain (worker pays gas + fees). Otherwise, you must already own the Basename.',
      },
      'GET /api/register/price/:name': {
        description: 'Check Basename availability and registration price (public, no auth)',
        response: '{ name, basename, available, price_wei?, price_eth? }',
      },

      // — Email (token required) —
      'POST /api/send': {
        auth: 'Bearer token',
        description: 'Send email. Internal @basemail.ai is free. External costs 1 credit. Optionally attach a verified USDC payment (Base Sepolia testnet).',
        body: '{ to, subject, body, html?, in_reply_to?, attachments?: [{ filename, content_type, data }], usdc_payment?: { tx_hash, amount } }',
        response: '{ success, email_id, from, to, usdc_payment? }',
        note: 'If usdc_payment is provided, the USDC transfer is verified on-chain (Base Sepolia). See labs.usdc_hackathon for full flow.',
      },
      'GET /api/inbox': {
        auth: 'Bearer token',
        description: 'List emails',
        query: '?folder=inbox|sent&limit=50&offset=0',
        response: '{ emails: [...], total, unread }',
      },
      'GET /api/inbox/:id': {
        auth: 'Bearer token',
        description: 'Get full email by ID (includes raw body)',
        response: '{ id, from_addr, to_addr, subject, body, created_at, ... }',
      },
      'DELETE /api/inbox/:id': {
        auth: 'Bearer token',
        description: 'Delete an email',
      },

      // — Credits (token required) —
      'GET /api/credits': {
        auth: 'Bearer token',
        description: 'Check credit balance',
        response: '{ credits, pricing }',
      },
      'POST /api/credits/buy': {
        auth: 'Bearer token',
        description: 'Submit ETH payment tx hash to receive credits',
        body: '{ tx_hash: "0x..." }',
        note: `Send ETH on Base chain to ${DEPOSIT}, then submit tx hash here.`,
        pricing: '1 ETH = 1,000,000 credits. Min: 0.0001 ETH = 100 credits. 1 credit = 1 external email.',
      },

      // — Pro —
      'GET /api/pro/status': {
        auth: 'Bearer token',
        description: 'Check Pro membership status and pricing',
        response: '{ handle, tier, is_pro, benefits, upgrade }',
      },
      'POST /api/pro/buy': {
        auth: 'Bearer token',
        description: 'Purchase BaseMail Pro with ETH payment (one-time lifetime)',
        body: '{ tx_hash: "0x...", chain_id?: 8453|1 }',
        response: '{ success, tier: "pro", eth_spent, benefits, bonus_credits }',
        note: `Send 0.008 ETH to ${DEPOSIT} on Base or ETH Mainnet, then submit tx hash. Pro removes email signatures, adds gold badge.`,
      },

      // — Public —
      'GET /api/identity/:address': {
        description: 'Look up email for any wallet (public, no auth)',
        response: '{ handle, email, basename }',
      },
    },

    // ══════════════════════════════════════════════
    // LABS: USDC HACKATHON (TESTNET ONLY)
    // ══════════════════════════════════════════════
    labs: {
      usdc_hackathon: {
        title: 'USDC Verified Payment Email (TESTNET ONLY)',
        warning: 'This feature runs on Base Sepolia TESTNET. Do NOT use mainnet funds or real USDC.',
        network: 'Base Sepolia (Chain ID: 84532)',
        usdc_contract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        description: 'Send USDC to any BaseMail user by email address. The payment is verified on-chain and the email is marked as a Verified Payment receipt.',
        flow: [
          {
            step: 1,
            action: 'Resolve recipient wallet',
            method: 'GET',
            url: `${BASE}/api/identity/:handle`,
            example: `curl ${BASE}/api/identity/alice`,
            response: '{ handle, email, wallet: "0x..." }',
            note: 'Use the "wallet" field as the USDC transfer destination.',
          },
          {
            step: 2,
            action: 'Transfer USDC on Base Sepolia',
            description: 'Call USDC.transfer(recipientWallet, amount) on Base Sepolia. Optionally append "basemail:handle@basemail.ai" as trailing calldata for on-chain memo.',
            usdc_contract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            note: 'Amount uses 6 decimals. e.g. 10 USDC = 10000000',
          },
          {
            step: 3,
            action: 'Send verified payment email',
            method: 'POST',
            url: `${BASE}/api/send`,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_TOKEN' },
            body: {
              to: 'recipient@basemail.ai',
              subject: 'Payment: 10 USDC',
              body: 'Here is your payment of 10 USDC.',
              usdc_payment: {
                tx_hash: '0x...',
                amount: '10.00',
              },
            },
            response: '{ success, email_id, usdc_payment: { verified: true, amount: "10.00", tx_hash: "0x...", network: "Base Sepolia (Testnet)" } }',
            note: 'Worker verifies the USDC Transfer event on-chain before marking the email as a verified payment.',
          },
        ],
        on_chain_memo: {
          description: 'Append recipient basemail address as trailing calldata to USDC transfer for on-chain advertising.',
          example: 'Transfer calldata + hex("basemail:alice@basemail.ai")',
          note: 'Solidity ignores trailing calldata. Visible in BaseScan Input Data field.',
        },
        faucets: {
          description: 'Get free testnet tokens to test USDC payments.',
          eth: {
            url: 'https://www.alchemy.com/faucets/base-sepolia',
            amount: '0.1 ETH per 24 hours',
            note: 'Select "Base Sepolia" network, paste your wallet address.',
          },
          usdc: {
            url: 'https://faucet.circle.com/',
            amount: '20 USDC per 2 hours',
            note: 'Select "Base Sepolia" network, paste your wallet address.',
          },
        },
        agent_quickstart: {
          overview: 'Full flow for AI agents to send USDC payments via email. 4 steps total.',
          steps: [
            {
              step: 0,
              action: 'Get testnet tokens',
              description: 'Your wallet needs Base Sepolia ETH (for gas) and USDC (to send). Use the faucets above, or ask a human to send you some.',
              eth_faucet: 'https://www.alchemy.com/faucets/base-sepolia',
              usdc_faucet: 'https://faucet.circle.com/',
            },
            {
              step: 1,
              action: 'Register on BaseMail (if not already)',
              method: 'POST /api/auth/start → POST /api/auth/agent-register',
              note: 'See quick_start above for full auth flow.',
            },
            {
              step: 2,
              action: 'Resolve recipient email → wallet address',
              method: 'GET',
              url: `${BASE}/api/identity/:handle`,
              note: 'Use the wallet address as the USDC transfer destination.',
            },
            {
              step: 3,
              action: 'Transfer USDC on-chain (Base Sepolia)',
              description: 'Call USDC contract transfer(recipientWallet, amountInSmallestUnit). USDC has 6 decimals, so 10 USDC = 10000000.',
              contract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              chain_id: 84532,
            },
            {
              step: 4,
              action: 'Send verified payment email',
              method: 'POST',
              url: `${BASE}/api/send`,
              body: '{ to: "handle@basemail.ai", subject: "Payment: 10 USDC", body: "...", usdc_payment: { tx_hash: "0x...", amount: "10.00" } }',
              note: 'Worker verifies the USDC transfer on Base Sepolia and marks the email as a Verified Payment.',
            },
          ],
        },
      },
    },

    // ══════════════════════════════════════════════
    // IMPORTANT NOTES
    // ══════════════════════════════════════════════
    notes: [
      'Base URL is https://api.basemail.ai (or https://basemail.ai/api/* which redirects here)',
      'All authenticated endpoints require header: Authorization: Bearer <token>',
      'Tokens expire in 24 hours — call /api/auth/start + /api/auth/agent-register again to refresh',
      'Internal emails (@basemail.ai to @basemail.ai) are FREE and unlimited',
      'External emails cost 1 credit each — buy credits by sending ETH on Base chain',
      `Deposit address for credits: ${DEPOSIT}`,
      'Wallet addresses are case-insensitive',
      'If your wallet has a Basename (e.g. alice.base.eth), your email will be alice@basemail.ai',
      'Without a Basename, your email will be 0xYourAddress@basemail.ai',
      'Both addresses receive mail if you have a Basename',
      'Already registered with 0x handle? Use PUT /api/register/upgrade with auto_basename:true to purchase a Basename and upgrade',
      'Check name availability first: GET /api/register/price/:name',
      'Auth errors include a "code" field (nonce_expired, signature_invalid, no_nonce_in_message) for programmatic error handling',
      'If GET /api/register/check shows has_basename_nft:true but basename:null, pass your basename directly in agent-register: { basename: "yourname.base.eth" }',
      'All auth responses include "tier" field: "free" or "pro"',
      'Free-tier emails include a BaseMail.ai signature. Upgrade to Pro (0.008 ETH one-time) to remove it.',
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
app.route('/api/waitlist', waitlistRoutes);

// 匯出 fetch handler (HTTP) 與 email handler (incoming mail)
export default {
  fetch: app.fetch,
  email: handleIncomingEmail,
};
