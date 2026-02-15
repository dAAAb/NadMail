/**
 * NNS .nad Name Lookup Module
 * Enumerates .nad NFTs owned by a wallet address using on-chain queries.
 *
 * Uses ERC-721 Enumerable: balanceOf → tokenOfOwnerByIndex → tokenURI → decode name.
 * NNS uses sequential integer tokenIds (NOT namehash).
 * tokenURI returns: https://api.nad.domains/nft-metadata/143/{base64_encoded_name}
 */

import { createPublicClient, http } from 'viem';

const NNS_CONTRACT = '0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7' as const;

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

const nnsReadAbi = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view' as const,
    type: 'function' as const,
  },
] as const;

const MAX_NFTS = 20; // Safety cap to prevent timeout

/**
 * Parse a .nad name from a tokenURI string.
 * Format: https://api.nad.domains/nft-metadata/143/{base64_encoded_name}
 */
function parseNadNameFromTokenURI(tokenURI: string): string | null {
  try {
    const segments = tokenURI.split('/');
    const base64Name = segments[segments.length - 1];
    if (!base64Name) return null;

    // Pad base64 if needed
    const padded = base64Name + '='.repeat((4 - (base64Name.length % 4)) % 4);
    const decoded = atob(padded);

    // Strip .nad suffix if present
    return decoded.endsWith('.nad') ? decoded.slice(0, -4) : decoded;
  } catch {
    return null;
  }
}

/**
 * Enumerate all .nad names owned by a wallet address.
 * Returns an array of name strings (without .nad suffix).
 */
export async function getNadNamesForWallet(
  walletAddress: string,
  rpcUrl: string,
): Promise<string[]> {
  const client = createPublicClient({
    chain: monad,
    transport: http(rpcUrl),
  });

  const addr = walletAddress as `0x${string}`;

  // Step 1: Get NFT count
  const balance = await client.readContract({
    address: NNS_CONTRACT,
    abi: nnsReadAbi,
    functionName: 'balanceOf',
    args: [addr],
  });

  const count = Number(balance);
  if (count === 0) return [];

  const limit = Math.min(count, MAX_NFTS);

  // Step 2: Get all tokenIds in parallel
  const tokenIdPromises = Array.from({ length: limit }, (_, i) =>
    client.readContract({
      address: NNS_CONTRACT,
      abi: nnsReadAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [addr, BigInt(i)],
    }),
  );
  const tokenIds = await Promise.all(tokenIdPromises);

  // Step 3: Get all tokenURIs in parallel
  const uriPromises = tokenIds.map((tokenId) =>
    client.readContract({
      address: NNS_CONTRACT,
      abi: nnsReadAbi,
      functionName: 'tokenURI',
      args: [tokenId],
    }),
  );
  const uris = await Promise.all(uriPromises);

  // Step 4: Parse names from URIs
  const names: string[] = [];
  for (const uri of uris) {
    const name = parseNadNameFromTokenURI(uri);
    if (name) names.push(name);
  }

  return names;
}
