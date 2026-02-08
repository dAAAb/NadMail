/**
 * Basename 鏈上註冊模組
 *
 * 在 Base Mainnet 上透過 UpgradeableRegistrarController 合約註冊 .base.eth 名稱
 * 合約使用單筆交易註冊（無 commit-reveal）
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  namehash,
  formatEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { normalize } from 'viem/ens';

// ── 合約地址（UpgradeableRegistrarController proxy） ──
const REGISTRAR_CONTROLLER = '0xa7d2607c6BD39Ae9521e514026CBB078405Ab322' as const;
const L2_RESOLVER = '0x426fA03fB86E510d0Dd9F70335Cf102a98b10875' as const;

// ── ABI ──
const RegistrarControllerABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'request',
      type: 'tuple',
      components: [
        { name: 'name', type: 'string' },
        { name: 'owner', type: 'address' },
        { name: 'duration', type: 'uint256' },
        { name: 'resolver', type: 'address' },
        { name: 'data', type: 'bytes[]' },
        { name: 'reverseRecord', type: 'bool' },
        { name: 'coinTypes', type: 'uint256[]' },
        { name: 'signatureExpiry', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    outputs: [],
  },
  {
    name: 'registerPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'available',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const L2ResolverABI = [
  {
    name: 'setAddr',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'a', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'setName',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'newName', type: 'string' },
    ],
    outputs: [],
  },
] as const;

const BASE_RPC = 'https://base.publicnode.com';
const ONE_YEAR = BigInt(365 * 24 * 60 * 60);

/**
 * 檢查 Basename 是否可用
 */
export async function isBasenameAvailable(name: string): Promise<boolean> {
  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  return client.readContract({
    address: REGISTRAR_CONTROLLER,
    abi: RegistrarControllerABI,
    functionName: 'available',
    args: [name],
  });
}

/**
 * 查詢 Basename 註冊價格
 */
export async function getBasenamePrice(name: string, years: number = 1): Promise<bigint> {
  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const duration = ONE_YEAR * BigInt(years);
  return client.readContract({
    address: REGISTRAR_CONTROLLER,
    abi: RegistrarControllerABI,
    functionName: 'registerPrice',
    args: [name, duration],
  });
}

/**
 * 註冊 Basename
 *
 * @param name - 名稱標籤（例如 "basemailai"，不含 .base.eth）
 * @param ownerAddress - 擁有者地址
 * @param privateKey - Worker 錢包私鑰（用來發送交易並支付費用）
 * @param years - 註冊年數，預設 1 年
 * @returns 交易 hash 和完整名稱
 */
export async function registerBasename(
  name: string,
  ownerAddress: Address,
  privateKey: Hex,
  years: number = 1,
): Promise<{ txHash: Hex; fullName: string; price: string }> {
  const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    chain: base,
    transport: http(BASE_RPC),
    account,
  });

  // 1. 確認可用
  const available = await publicClient.readContract({
    address: REGISTRAR_CONTROLLER,
    abi: RegistrarControllerABI,
    functionName: 'available',
    args: [name],
  });
  if (!available) {
    throw new Error(`${name}.base.eth is not available`);
  }

  // 2. 查詢價格
  const duration = ONE_YEAR * BigInt(years);
  const price = await publicClient.readContract({
    address: REGISTRAR_CONTROLLER,
    abi: RegistrarControllerABI,
    functionName: 'registerPrice',
    args: [name, duration],
  });

  // 3. 編碼 resolver data
  const fullName = `${name}.base.eth`;
  const node = namehash(normalize(fullName));

  const addressData = encodeFunctionData({
    abi: L2ResolverABI,
    functionName: 'setAddr',
    args: [node, ownerAddress],
  });

  const nameData = encodeFunctionData({
    abi: L2ResolverABI,
    functionName: 'setName',
    args: [node, fullName],
  });

  // 4. 發送註冊交易（加 10% buffer 防止價格波動）
  const value = price + (price / 10n);

  const txHash = await walletClient.writeContract({
    address: REGISTRAR_CONTROLLER,
    abi: RegistrarControllerABI,
    functionName: 'register',
    args: [{
      name,
      owner: ownerAddress,
      duration,
      resolver: L2_RESOLVER,
      data: [addressData, nameData],
      reverseRecord: true,
      coinTypes: [],
      signatureExpiry: 0n,
      signature: '0x',
    }],
    value,
  });

  // 5. 等待確認
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    fullName,
    price: formatEther(price),
  };
}
