export interface Env {
  // Bindings
  DB: D1Database;
  EMAIL_STORE: R2Bucket;
  NONCE_KV: KVNamespace;
  SEND_EMAIL: SendEmail;

  // Variables
  DOMAIN: string;
  BASE_CHAIN_ID: string;
  JWT_SECRET?: string;
  WALLET_PRIVATE_KEY?: string;  // Worker 錢包私鑰，用於代付 Basename 註冊
  RESEND_API_KEY?: string;      // Resend.com API Key，用於外部寄信
  WALLET_ADDRESS?: string;      // Worker 錢包公開地址，用於收取 credit 購買費用
}

export interface Account {
  handle: string;
  wallet: string;
  basename: string | null;
  webhook_url: string | null;
  created_at: number;
  tx_hash: string | null;
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
}

export interface WaitlistEntry {
  id: string;
  wallet: string;
  desired_handle: string;
  created_at: number;
}

// SIWE auth context
export interface AuthContext {
  wallet: string;
  handle: string;
}
