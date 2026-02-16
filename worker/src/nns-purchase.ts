/**
 * NNS .nad Name Proxy Purchase Module
 * 透過 NNS API 取得註冊簽名，再呼叫 registerWithSignature 代購 .nad 名稱
 *
 * 編碼方式（逆向自 nad.domains 前端）：
 *   encode: JSON.stringify → base64url → caesarShift(-19)
 *   decode: caesarShift(+19) → base64url → JSON.parse
 */

import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Env } from './types';

const NNS_REGISTRAR = '0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb' as const;
const NNS_API_BASE = 'https://api.nad.domains' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

const registerWithSignatureAbi = [
  {
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'nameOwner', type: 'address' },
          { name: 'setAsPrimaryName', type: 'bool' },
          { name: 'referrer', type: 'address' },
          { name: 'discountKey', type: 'bytes32' },
          { name: 'discountClaimProof', type: 'bytes' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          {
            name: 'attributes',
            type: 'tuple[]',
            components: [
              { name: 'key', type: 'string' },
              { name: 'value', type: 'string' },
            ],
          },
          { name: 'paymentToken', type: 'address' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'registerWithSignature',
    outputs: [],
    stateMutability: 'payable' as const,
    type: 'function' as const,
  },
] as const;

// ── Caesar Cipher（逆向自 nad.domains 前端 module 45708）──

function caesarShift(text: string, shift: number): string {
  const n = ((shift % 26) + 26) % 26;
  return text.split('').map(char => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode((code - 65 + n) % 26 + 65);
    }
    if (code >= 97 && code <= 122) {
      return String.fromCharCode((code - 97 + n) % 26 + 97);
    }
    return char;
  }).join('');
}

// ── Base64url 編解碼（使用 Buffer polyfill，已在 index.ts 設定）──

function base64urlEncode(data: string): string {
  return btoa(data)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(data: string): string {
  let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(pad);
  return atob(base64);
}

// ── NNS API 資料編碼/解碼 ──

function encodeNnsData(data: object): string {
  const json = JSON.stringify(data);
  const b64 = base64urlEncode(json);
  return caesarShift(b64, -19);
}

function decodeNnsData<T = any>(encoded: string): T {
  const shifted = caesarShift(encoded, 19);
  const json = base64urlDecode(shifted);
  return JSON.parse(json);
}

// ── NNS Discount Proofs API ──

interface DiscountProof {
  discountKey: string;
  validationData: string;
}

interface ActiveDiscount {
  active: boolean;
  discountVerifier: string;
  key: string;           // bytes32
  discountPercent: bigint;
  description: string;
}

export async function getDiscountProofs(
  claimer: string,
  name: string,
): Promise<DiscountProof[]> {
  try {
    const url = `${NNS_API_BASE}/discount-proofs?claimer=${claimer}&chainId=143&name=${encodeURIComponent(name)}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const body = await response.json() as any;
    if (body.success && Array.isArray(body.proofs)) {
      return body.proofs;
    }
    return [];
  } catch {
    return [];
  }
}

// ── Referral Code 編解碼（逆向自 nad.domains module 45708）──

export function encodeReferralCode(address: string): string {
  const b64 = btoa(address);
  return caesarShift(b64, 9);
}

export function decodeReferralCode(rc: string): string {
  const b64 = caesarShift(rc, -9);
  return atob(b64);
}

// ── NNS API 簽名取得 ──

interface NnsSignatureResponse {
  nonce: string;
  deadline: string;
  signature: string;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export async function getNnsRegistrationSignature(
  name: string,
  nameOwner: string,
  options?: {
    referrer?: string;
    discountKey?: string;
    discountClaimProof?: string;
  },
): Promise<NnsSignatureResponse> {
  const data = {
    name,
    nameOwner,
    setAsPrimaryName: false,
    referrer: options?.referrer || ZERO_ADDRESS,
    discountKey: options?.discountKey || ZERO_BYTES32,
    discountClaimProof: options?.discountClaimProof || '0x',
    attributes: [],
    paymentToken: ZERO_ADDRESS,
    chainId: '143',
  };

  const encoded = encodeNnsData(data);
  const url = `${NNS_API_BASE}/v3/register/signature?data=${encoded}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Origin': 'https://app.nad.domains',
          'Referer': 'https://app.nad.domains/',
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown');
        // 4xx = client error, don't retry
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`NNS API rejected request (${response.status}): ${text}`);
        }
        throw new Error(`NNS API error (${response.status}): ${text}`);
      }

      const body = await response.json() as any;

      // NNS API 回傳格式：{ success: bool, data: encoded_string }
      if (body.success && body.data) {
        try {
          const decoded = decodeNnsData<NnsSignatureResponse>(body.data);
          if (decoded.nonce && decoded.deadline && decoded.signature) {
            return decoded;
          }
        } catch {
          // 可能不是 Caesar 編碼，嘗試直接使用
        }
      }

      // 嘗試直接從 body 取得
      if (body.nonce && body.deadline && body.signature) {
        return body as NnsSignatureResponse;
      }

      // 嘗試從 body.data 直接解析（可能已是 JSON 物件）
      if (body.data && typeof body.data === 'object') {
        const d = body.data as any;
        if (d.nonce && d.deadline && d.signature) {
          return d as NnsSignatureResponse;
        }
      }

      throw new Error('NNS API returned unexpected response format');
    } catch (e: any) {
      lastError = e;
      // 4xx errors = don't retry
      if (e.message?.includes('rejected request')) throw e;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('NNS API request failed');
}

// ── 核心購買執行 ──

export interface ProxyPurchaseResult {
  txHash: string;
  name: string;
  nameOwner: string;
}

export async function executeNnsPurchase(
  name: string,
  nameOwner: string,
  priceWei: bigint,
  env: Env,
  options?: {
    referrer?: string;
    discountKey?: string;
    discountClaimProof?: string;
    discountPercent?: number;
  },
): Promise<ProxyPurchaseResult> {
  if (!env.WALLET_PRIVATE_KEY) {
    throw new Error('Worker wallet not configured');
  }

  // Proxy purchases: do NOT use discounts.
  // NNS discount verifiers check msg.sender eligibility, but in proxy mode
  // msg.sender is the Worker wallet, not the nameOwner. This causes reverts.
  // Instead, we pay full price and pass the savings as a lower service fee to users.
  const discountKey = ZERO_BYTES32;
  const discountClaimProof = '0x';
  console.log(`[nns-purchase] Proxy mode: using full price (no discount) for ${name}`);

  // 2. Referrer（使用 diplomat.nad 作為預設）
  const referrer = options?.referrer || (env as any).NNS_REFERRER || ZERO_ADDRESS;

  // 3. 取得 NNS 註冊簽名
  const { nonce, deadline, signature } = await getNnsRegistrationSignature(name, nameOwner, {
    referrer,
    discountKey,
    discountClaimProof,
  });

  // 4. 建立 viem clients
  const account = privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex);
  const walletClient = createWalletClient({
    account,
    chain: monad,
    transport: http(env.MONAD_RPC_URL),
  });
  const publicClient = createPublicClient({
    chain: monad,
    transport: http(env.MONAD_RPC_URL),
  });

  // 5. Payment value = full price (priceWei passed in is the base/undiscounted price)
  const paymentValue = priceWei;

  // 6. 呼叫 registerWithSignature（Worker 付 MON，NFT 鑄造給 nameOwner）
  const hash = await walletClient.writeContract({
    address: NNS_REGISTRAR,
    abi: registerWithSignatureAbi,
    functionName: 'registerWithSignature',
    args: [
      {
        name,
        nameOwner: nameOwner as `0x${string}`,
        setAsPrimaryName: false,
        referrer: referrer as `0x${string}`,
        discountKey: discountKey as `0x${string}`,
        discountClaimProof: discountClaimProof as Hex,
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
        attributes: [],
        paymentToken: ZERO_ADDRESS,
      },
      signature as Hex,
    ],
    value: paymentValue,
    gas: 1_000_000n,
  });

  // 7. 等待確認
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 30_000,
  });

  if (receipt.status !== 'success') {
    throw new Error(`Registration transaction reverted: ${hash}`);
  }

  return { txHash: hash, name, nameOwner };
}
