/**
 * NNS .nad NFT 轉移模組
 * 將 Worker 錢包持有的 .nad NFT 轉給用戶
 */

import { createPublicClient, createWalletClient, http, namehash, type Hex } from 'viem';
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
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
] as const;

/**
 * Transfer a .nad NFT from the worker wallet to a user.
 * tokenId = uint256(namehash("name.nad"))
 */
export async function transferNadName(
  nadName: string,  // e.g. "euler" (without .nad)
  toAddress: string,
  env: Env,
): Promise<string> {
  if (!env.WALLET_PRIVATE_KEY) throw new Error('Worker wallet not configured');

  const account = privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex);

  const publicClient = createPublicClient({
    chain: monad,
    transport: http(env.MONAD_RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: monad,
    transport: http(env.MONAD_RPC_URL),
  });

  // Compute tokenId from namehash
  const fullName = `${nadName}.nad`;
  const node = namehash(fullName);
  const tokenId = BigInt(node);

  // Verify worker owns the NFT
  const owner = await publicClient.readContract({
    address: NNS_CONTRACT,
    abi: erc721Abi,
    functionName: 'ownerOf',
    args: [tokenId],
  });

  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Worker does not own ${fullName} (owner: ${owner})`);
  }

  // Transfer NFT
  const hash = await walletClient.writeContract({
    address: NNS_CONTRACT,
    abi: erc721Abi,
    functionName: 'transferFrom',
    args: [account.address, toAddress as `0x${string}`, tokenId],
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}
