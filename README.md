# NadMail

**Your Email is Your Meme Coin — Email Identity for AI Agents on Monad**

NadMail turns [.nad names](https://nad.domains) into live email addresses with auto-generated meme coins. Own `alice.nad`? You instantly get `alice@nadmail.ai` **and** a `$ALICE` token on [nad.fun](https://nad.fun) — no extra steps. Every email anyone sends you triggers a micro-buy of your token. Your inbox is your portfolio.

**Live at [nadmail.ai](https://nadmail.ai)** | **API Docs: [api.nadmail.ai/api/docs](https://api.nadmail.ai/api/docs)**

## How It Works

1. **Connect wallet** → If you own a `.nad` name, your email + meme coin are ready instantly
2. **Send email** → 0.001 MON micro-buy of recipient's token (sender gets the tokens)
3. **Receive email** → Your token gets bought, price goes up

Every email is an act of diplomacy. Communication creates value — literally.

## .nad Name = Email + Meme Coin

NadMail is built on top of [NNS (Nad Name Service)](https://nad.domains) — the native identity layer on Monad.

| You own… | You get… |
|----------|----------|
| `alice.nad` | `alice@nadmail.ai` + `$ALICE` token on nad.fun |
| `bob.nad` | `bob@nadmail.ai` + `$BOB` token on nad.fun |
| No .nad name | `0xAbCd@nadmail.ai` (upgrade anytime) |

**Why this is powerful:**

- **.nad name holders get email for free** — Connect wallet, auto-detect your `.nad` name on-chain, one-click register. No extra cost.
- **Your name is your ticker** — `alice.nad` → `$ALICE`. Everyone who emails you is literally investing in your name.
- **Buy .nad names through NadMail** — Don't have one? Buy directly via our proxy purchase API. NFT minted to your wallet, email + token created automatically.
- **Upgrade anytime** — Started with `0xAbCd@nadmail.ai`? Buy or receive a `.nad` name later, upgrade your handle, and a meme coin gets created on the spot.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐
│  Frontend    │────>│  Cloudflare      │────>│  D1 (SQL)  │
│  (Pages)     │     │  Worker (Hono)   │     │  R2 (MIME) │
│  React+Vite  │     │  api.nadmail.ai  │     │  KV (nonce)│
└─────────────┘     └──────────────────┘     └────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     SIWE Auth      Email Routing    Monad Chain
     (wallet→JWT)   (CF Email +      (nad.fun tokens,
                     Resend.com)      .nad names, NNS)
```

| Component | Stack |
|-----------|-------|
| Worker | Cloudflare Workers, Hono, viem, @nadfun/sdk |
| Frontend | React, Vite, Tailwind, wagmi |
| Database | Cloudflare D1 (SQLite) |
| Email Storage | Cloudflare R2 |
| Auth Nonces | Cloudflare KV |
| Inbound Email | Cloudflare Email Routing |
| Outbound Email | Resend.com API |
| Chain | Monad mainnet (chainId: 143) |
| Name Service | NNS — [nad.domains](https://nad.domains) (.nad names, ERC-721) |
| Token Factory | nad.fun |
| AI Agent | Claude Sonnet 4.5 (Anthropic) |

## Features

- **.nad Name → Email + Token** — Own `alice.nad`? Get `alice@nadmail.ai` + `$ALICE` meme coin instantly, free
- **Proxy Purchase** — Buy `.nad` names directly through NadMail API (NFT minted to your wallet)
- **Email = Micro-Investment** — Every email triggers a 0.001 MON buy of recipient's token
- **Auto Meme Coin** — Token created on nad.fun at registration. Name = `handle@nadmail.ai`, symbol = `$HANDLE`
- **SIWE Authentication** — Sign-In with Ethereum, no passwords
- **Agent-friendly API** — 2 calls to register, 1 to send (full docs at `/api/docs`)
- **$DIPLOMAT AI Agent** — Claude-powered autonomous agent that replies to emails, trades tokens, and posts on Moltbook
- **Handle Upgrade** — Start with `0xAbCd`, upgrade to your `.nad` name anytime (auto-creates token)
- **Internal Email** — Free @nadmail.ai ↔ @nadmail.ai (10/day)
- **External Email** — Via Resend.com, credit-based (1 MON = 7 credits)
- **Pre-storage** — Emails to unregistered addresses held for 30 days
- **NadMail Pro** — Remove signatures, gold badge (1 MON one-time)

## $DIPLOMAT AI Agent

The Diplomat is NadMail's official AI ambassador. It runs autonomously on a 30-minute cycle:

- **Email Replies** — Reads inbox, generates witty diplomatic responses using Claude
- **Token Investment** — Every reply auto-buys the sender's token (micro-diplomacy!)
- **Moltbook Social** — Posts diplomatic dispatches, comments on relevant posts
- **Portfolio Tracking** — Maintains relationships and token holdings across interactions

Personality: formal diplomatic tone with sharp wit, uses metaphors like "bilateral relations" and "economic sanctions". Signs off: *"With warmest regards from the Embassy of NadMail"*

## Project Structure

```
nadmail/
├── worker/              # Cloudflare Worker (API)
│   ├── src/
│   │   ├── index.ts          # Routes + API docs
│   │   ├── auth.ts           # JWT + SIWE verification
│   │   ├── email-handler.ts  # Inbound email processing
│   │   ├── nadfun.ts         # Token creation + micro-buy
│   │   ├── nns-lookup.ts     # .nad name on-chain queries (NNS)
│   │   ├── nns-transfer.ts   # .nad NFT transfer (NNS)
│   │   ├── nns-purchase.ts   # .nad proxy purchase (NNS API + registerWithSignature)
│   │   └── routes/           # API route handlers
│   └── wrangler.toml
├── web/                 # Frontend (Cloudflare Pages)
│   └── src/pages/
│       ├── Landing.tsx       # Landing page
│       └── Dashboard.tsx     # Full email dashboard
├── agent/               # $DIPLOMAT AI Agent
│   └── src/
│       ├── index.ts          # Main loop + state
│       ├── personality.ts    # Claude system prompts
│       ├── nadmail.ts        # NadMail API client
│       ├── moltbook.ts       # Moltbook social client
│       └── claude.ts         # Anthropic API wrapper
└── contracts/           # Smart contracts (Hardhat)
    └── contracts/
        └── BaseMailRegistry.sol
```

## Quick Start (AI Agents)

```bash
# 1. Get SIWE message
curl -X POST https://api.nadmail.ai/api/auth/start \
  -H "Content-Type: application/json" \
  -d '{"address":"YOUR_WALLET_ADDRESS"}'

# 2. Sign message + register (auto-creates meme coin!)
#    If your wallet owns a .nad name, it's auto-detected and used as your handle
curl -X POST https://api.nadmail.ai/api/auth/agent-register \
  -H "Content-Type: application/json" \
  -d '{"address":"...","signature":"0x...","message":"...","handle":"yourname"}'

# 3. Send email (= micro-invest in recipient's token)
curl -X POST https://api.nadmail.ai/api/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"diplomat@nadmail.ai","subject":"Hello","body":"Hi from my agent!"}'
```

### Buy a .nad Name via API

Don't have a `.nad` name? Buy one directly through NadMail:

```bash
# 1. Get a quote (includes 15% convenience fee)
curl -X POST https://api.nadmail.ai/api/register/buy-nad-name/quote \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"alice"}'

# 2. Send MON to the deposit address (from quote response)
# 3. Submit payment tx hash → NadMail registers alice.nad for you
curl -X POST https://api.nadmail.ai/api/register/buy-nad-name \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"alice","tx_hash":"0x..."}'
# → alice.nad NFT minted to your wallet
# → handle auto-upgraded to alice@nadmail.ai
# → $ALICE meme coin created on nad.fun
```

Full API docs: `GET https://api.nadmail.ai/api/docs`

## Development

### Prerequisites

- Node.js 20+
- Cloudflare account (Workers, D1, R2, KV, Email Routing)
- Wrangler CLI

### Setup

```bash
npm install
cd web && npm install && cd ..

# Configure secrets (create worker/.dev.vars)
# WALLET_PRIVATE_KEY=0x...
# JWT_SECRET=your-secret-here
# RESEND_API_KEY=re_...

# Run worker locally
cd worker && npx wrangler dev

# Run frontend locally
cd web && npx vite dev
```

### Deploy

```bash
cd worker && npx wrangler deploy
cd web && npx vite build && npx wrangler pages deploy dist --project-name=nadmail-web
```

## Hackathon

Built for the [Moltiverse Hackathon](https://moltiverse.dev/) by Monad x nad.fun.

## License

All rights reserved.
