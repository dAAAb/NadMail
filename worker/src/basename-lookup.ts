/**
 * Basename Resolution
 *
 * Given a wallet address, look up if they own a Basename (e.g., alice.base.eth).
 *
 * Strategy:
 * 1. Try L2Resolver reverse resolution (fast, works if user set primary name)
 * 2. Check registrar balanceOf as fallback hint (user enters name manually in frontend)
 *
 * Based on Coinbase OnchainKit's approach.
 */
import {
  createPublicClient,
  http,
  encodePacked,
  keccak256,
  namehash,
  toBytes,
  type Address,
} from 'viem';
import { base, mainnet } from 'viem/chains';

const BASENAME_L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as const;
const BASENAME_REGISTRAR = '0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a' as const;
const BASE_RPC = 'https://base.publicnode.com';

const L2ResolverAbi = [
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Convert chain ID to ENSIP-11 coinType hex string
 */
function convertChainIdToCoinType(chainId: number): string {
  if (chainId === mainnet.id) return 'addr';
  const cointype = (0x80000000 | chainId) >>> 0;
  return cointype.toString(16).toUpperCase();
}

/**
 * Compute the reverse node for an address on a given chain
 */
function convertReverseNodeToBytes(address: Address, chainId: number): `0x${string}` {
  const addressFormatted = address.toLowerCase() as Address;
  const addressNode = keccak256(
    ('0x' + addressFormatted.substring(2)) as `0x${string}`
  );
  const chainCoinType = convertChainIdToCoinType(chainId);
  const baseReverseNode = namehash(`${chainCoinType.toUpperCase()}.reverse`);
  const addressReverseNode = keccak256(
    encodePacked(['bytes32', 'bytes32'], [baseReverseNode, addressNode]),
  );
  return addressReverseNode;
}

/**
 * Look up Basename via L2Resolver reverse resolution.
 * Returns the full name (e.g., "alice.base.eth") or null.
 * Only works if the user has set their primary name on-chain.
 */
export async function getBasenameForAddress(address: Address): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: base,
      transport: http(BASE_RPC),
    });

    const addressReverseNode = convertReverseNodeToBytes(address, base.id);

    const basename = await client.readContract({
      abi: L2ResolverAbi,
      address: BASENAME_L2_RESOLVER,
      functionName: 'name',
      args: [addressReverseNode],
    });

    if (basename && basename.length > 0) {
      return basename;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fallback: Check if address owns a Basename NFT via registrar balanceOf.
 * Returns true if the address owns at least one Basename token.
 * Used as a hint — actual name resolution happens via Etherscan API in the frontend.
 */
export async function hasBasenameNFT(address: Address): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
    const balance = await client.readContract({
      abi: [{
        inputs: [{ name: 'owner', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      }],
      address: BASENAME_REGISTRAR,
      functionName: 'balanceOf',
      args: [address],
    });
    return balance > 0n;
  } catch {
    return false;
  }
}

/**
 * Extract handle from a Basename.
 * "alice.base.eth" → "alice"
 */
export function basenameToHandle(basename: string): string {
  return basename.replace(/\.base\.eth$/, '');
}

/**
 * Convert wallet address to 0x handle format (lowercase, full address).
 */
export function addressToHandle(address: string): string {
  return address.toLowerCase();
}

/**
 * Determine the email handle for a wallet address.
 * Priority: Basename (reverse resolution) > 0x address
 *
 * Also checks registrar balanceOf as a hint for the frontend.
 */
export async function resolveHandle(address: Address): Promise<{
  handle: string;
  basename: string | null;
  source: 'basename' | 'address';
  has_basename_nft?: boolean;
}> {
  // Try reverse resolution first (fast, works if user set primary name)
  const basename = await getBasenameForAddress(address);

  if (basename) {
    return {
      handle: basenameToHandle(basename),
      basename,
      source: 'basename',
    };
  }

  // Check if address owns any Basename NFT (fast on-chain check)
  const hasNFT = await hasBasenameNFT(address);

  return {
    handle: addressToHandle(address),
    basename: null,
    source: 'address',
    has_basename_nft: hasNFT || undefined,
  };
}

/**
 * Verify on-chain ownership of a Basename via registrar's ownerOf().
 * Used by both agent-register and upgrade endpoints.
 *
 * @param basename Full basename e.g. "alice.base.eth"
 * @param expectedOwner Wallet address expected to own the NFT
 * @returns { valid: true, name } or { valid: false, error }
 */
export async function verifyBasenameOwnership(
  basename: string,
  expectedOwner: string,
): Promise<{ valid: true; name: string } | { valid: false; error: string }> {
  const name = basename.replace(/\.base\.eth$/, '');
  const labelhash = keccak256(toBytes(name));
  const tokenId = BigInt(labelhash);

  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  try {
    const owner = await client.readContract({
      abi: [{
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        name: 'ownerOf',
        outputs: [{ name: '', type: 'address' }],
        stateMutability: 'view',
        type: 'function',
      }],
      address: BASENAME_REGISTRAR,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
      return { valid: false, error: `You do not own ${basename}. The owner is ${owner}.` };
    }
    return { valid: true, name };
  } catch {
    return { valid: false, error: `Failed to verify ownership of ${basename} on-chain` };
  }
}
