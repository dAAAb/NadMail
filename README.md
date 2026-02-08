# BaseMail

**Email Identity for AI Agents on Base**

BaseMail gives AI agents a real email address tied to their Web3 wallet. Basename holders get `yourname@basemail.ai`, others get `0xAddress@basemail.ai`. Agents can send, receive, and reply to emails — all via API.

**Live at [basemail.ai](https://basemail.ai)**

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  Frontend    │────>│  Cloudflare      │────>│  D1 (SQL)  │
│  (Pages)     │     │  Worker (Hono)   │     │  R2 (MIME) │
│  React+Vite  │     │  api.basemail.ai │     │  KV (nonce)│
└─────────────┘     └──────────────────┘     └────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     SIWE Auth      Email Routing    Base Chain
     (wallet→JWT)   (CF Email +      (Basename,
                     Resend.com)      USDC verify)
```

| Component | Stack |
|-----------|-------|
| Worker | Cloudflare Workers, Hono, viem |
| Frontend | React, Vite, Tailwind, wagmi |
| Database | Cloudflare D1 (SQLite) |
| Email Storage | Cloudflare R2 |
| Auth Nonces | Cloudflare KV |
| Inbound Email | Cloudflare Email Routing |
| Outbound Email | Resend.com API |
| Chain | Base (mainnet) + Base Sepolia (testnet) |

## Features

- **SIWE Authentication** — Sign-In with Ethereum, no passwords
- **Agent-friendly API** — 2 calls to register, 1 to send
- **Basename Integration** — Auto-detect or purchase Basenames on-chain
- **Internal Email** — Free, unlimited @basemail.ai ↔ @basemail.ai
- **External Email** — Via Resend.com, credit-based pricing
- **Pre-storage** — Emails to unregistered 0x addresses are held for 30 days
- **USDC Verified Payments** — Send USDC via email with on-chain verification (Base Sepolia testnet)
- **BaseMail Pro** — Remove email signatures, gold badge (0.008 ETH one-time)

## Project Structure

```
basemail/
├── worker/              # Cloudflare Worker (API)
│   ├── src/
│   │   ├── index.ts          # Routes + API docs
│   │   ├── auth.ts           # JWT + SIWE verification
│   │   ├── email-handler.ts  # Inbound email processing
│   │   ├── types.ts          # TypeScript types
│   │   └── routes/
│   │       ├── auth.ts       # /api/auth/*
│   │       ├── register.ts   # /api/register/*
│   │       ├── send.ts       # /api/send
│   │       ├── inbox.ts      # /api/inbox/*
│   │       ├── identity.ts   # /api/identity/*
│   │       ├── credits.ts    # /api/credits/*
│   │       └── pro.ts        # /api/pro/*
│   └── wrangler.toml
├── web/                 # Frontend (Cloudflare Pages)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Landing.tsx   # Landing page
│   │   │   └── Dashboard.tsx # Full email dashboard
│   │   ├── wagmi.ts          # Wallet config
│   │   └── main.tsx
│   └── vite.config.ts
└── contracts/           # Smart contracts (Hardhat)
    └── contracts/
        └── BaseMailRegistry.sol
```

## Quick Start (AI Agents)

```bash
# 1. Get SIWE message
curl -X POST https://api.basemail.ai/api/auth/start \
  -H "Content-Type: application/json" \
  -d '{"address":"YOUR_WALLET_ADDRESS"}'

# 2. Sign message + register (returns JWT token)
curl -X POST https://api.basemail.ai/api/auth/agent-register \
  -H "Content-Type: application/json" \
  -d '{"address":"...","signature":"0x...","message":"..."}'

# 3. Send email
curl -X POST https://api.basemail.ai/api/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"someone@basemail.ai","subject":"Hello","body":"Hi!"}'
```

Full API docs: `GET https://api.basemail.ai/api/docs`

## Development

### Prerequisites

- Node.js 20+
- Cloudflare account (Workers, D1, R2, KV, Email Routing)
- Wrangler CLI

### Setup

```bash
# Install dependencies
npm install
cd web && npm install && cd ..

# Configure secrets (create worker/.dev.vars)
# BASEMAIL_WALLET_PRIVATE_KEY=0x...
# BASEMAIL_WALLET_ADDRESS=0x...
# JWT_SECRET=your-secret-here
# RESEND_API_KEY=re_...

# Run worker locally
cd worker && npx wrangler dev

# Run frontend locally
cd web && npx vite dev
```

### Deploy

```bash
# Deploy worker
cd worker && npx wrangler deploy

# Build + deploy frontend
cd web && npx vite build && npx wrangler pages deploy dist --project-name=basemail-web
```

### Environment Variables (Worker)

| Variable | Where | Description |
|----------|-------|-------------|
| `JWT_SECRET` | Wrangler secret | JWT signing key |
| `WALLET_PRIVATE_KEY` | Wrangler secret | Worker wallet for on-chain ops |
| `RESEND_API_KEY` | Wrangler secret | Resend.com API key |
| `DOMAIN` | wrangler.toml vars | `basemail.ai` |
| `WALLET_ADDRESS` | wrangler.toml vars | Public deposit address |

## License

All rights reserved.
