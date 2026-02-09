export interface Env {
  // Bindings
  DB: D1Database;
  EMAIL_STORE: R2Bucket;
  NONCE_KV: KVNamespace;
  AGENT_KV: KVNamespace;
  SEND_EMAIL: SendEmail;

  // Variables
  DOMAIN: string;
  MONAD_RPC_URL: string;         // https://monad-mainnet.drpc.org
  NADFUN_API_URL: string;        // https://api.nadapp.net
  NADFUN_LENS: string;           // 0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea
  NADFUN_ROUTER: string;         // 0x6F6B8F1a20703309951a5127c45B49b1CD981A22
  NADFUN_CURVE: string;          // 0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE
  WMON: string;                  // 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
  JWT_SECRET?: string;
  WALLET_PRIVATE_KEY?: string;   // Worker 錢包私鑰，用於代付 token 建立 + micro-buy
  RESEND_API_KEY?: string;       // Resend.com API Key，用於外部寄信
  WALLET_ADDRESS?: string;       // Worker 錢包公開地址，用於收取 credit 購買費用

  // $DIPLOMAT agent
  ANTHROPIC_API_KEY?: string;    // Claude API key
  MOLTBOOK_API_KEY?: string;     // Moltbook agent API key
  MOLTBOOK_AGENT_ID?: string;    // Moltbook agent ID
  MOLTBOOK_API_URL?: string;     // Moltbook API base URL
}

export interface Account {
  handle: string;
  wallet: string;
  nad_name: string | null;       // .nad domain (optional)
  token_address: string | null;  // nad.fun token contract address
  token_symbol: string | null;   // e.g. "ALICE"
  token_create_tx: string | null;
  webhook_url: string | null;
  created_at: number;
  tier: 'free' | 'pro';
}

export interface Email {
  id: string;
  handle: string;
  folder: 'inbox' | 'sent';
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  r2_key: string;
  size: number;
  read: number;
  created_at: number;
  microbuy_tx: string | null;
}

// SIWE auth context
export interface AuthContext {
  wallet: string;
  handle: string;
}
