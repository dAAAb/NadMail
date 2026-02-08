/**
 * NNS .nad NFT 轉移模組
 * 將 Worker 錢包持有的 .nad NFT 轉給用戶
 *
 * NNS uses sequential integer tokenIds (NOT namehash).
 * tokenId mapping is stored in the free_nad_names table.
 */

import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Env } from './types';

const NNS_CONTRACT = '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7' as const;

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://monad-mainnet.drpc.org'] } },
} as const;

const erc721Abi = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable' as const,
    type: 'function' as const,
  },
] as const;

/**
 * Transfer a .nad NFT from the worker wallet to a user.
 * Looks up the sequential tokenId from the free_nad_names table.
 */
export async function transferNadName(
  nadName: string,  // e.g. "euler" (without .nad)
  toAddress: string,
  env: Env,
): Promise<string> {
  if (!env.WALLET_PRIVATE_KEY) throw new Error('Worker wallet not configured');

  // Look up tokenId from DB
  const row = await env.DB.prepare(
    'SELECT token_id FROM free_nad_names WHERE name = ?'
  ).bind(nadName).first<{ token_id: number | null }>();

  if (!row || row.token_id === null) {
    throw new Error(`No tokenId found for ${nadName}.nad — check free_nad_names table`);
  }

  const tokenId = BigInt(row.token_id);
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

  // Transfer NFT (skip simulation — NNS eth_call doesn't handle msg.sender correctly)
  const hash = await walletClient.writeContract({
    address: NNS_CONTRACT,
    abi: erc721Abi,
    functionName: 'transferFrom',
    args: [account.address, toAddress as `0x${string}`, tokenId],
    gas: 500_000n,
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}
