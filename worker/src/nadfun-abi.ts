/**
 * nad.fun ABI 定義
 * 來源: https://nad.fun/abi.md
 */

export const lensAbi = [
  {
    type: "function",
    name: "getAmountOut",
    inputs: [
      { name: "_token", type: "address", internalType: "address" },
      { name: "_amountIn", type: "uint256", internalType: "uint256" },
      { name: "_isBuy", type: "bool", internalType: "bool" },
    ],
    outputs: [
      { name: "router", type: "address", internalType: "address" },
      { name: "amountOut", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAmountIn",
    inputs: [
      { name: "_token", type: "address", internalType: "address" },
      { name: "_amountOut", type: "uint256", internalType: "uint256" },
      { name: "_isBuy", type: "bool", internalType: "bool" },
    ],
    outputs: [
      { name: "router", type: "address", internalType: "address" },
      { name: "amountIn", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProgress",
    inputs: [{ name: "_token", type: "address", internalType: "address" }],
    outputs: [{ name: "progress", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isGraduated",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
] as const;

export const curveAbi = [
  {
    type: "function",
    name: "feeConfig",
    inputs: [],
    outputs: [
      { name: "deployFeeAmount", type: "uint256", internalType: "uint256" },
      { name: "graduateFeeAmount", type: "uint256", internalType: "uint256" },
      { name: "protocolFee", type: "uint24", internalType: "uint24" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "curves",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
    outputs: [
      { name: "realMonReserve", type: "uint256", internalType: "uint256" },
      { name: "realTokenReserve", type: "uint256", internalType: "uint256" },
      { name: "virtualMonReserve", type: "uint256", internalType: "uint256" },
      { name: "virtualTokenReserve", type: "uint256", internalType: "uint256" },
      { name: "k", type: "uint256", internalType: "uint256" },
      { name: "targetTokenAmount", type: "uint256", internalType: "uint256" },
      { name: "initVirtualMonReserve", type: "uint256", internalType: "uint256" },
      { name: "initVirtualTokenReserve", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export const bondingCurveRouterAbi = [
  {
    type: "function",
    name: "create",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IBondingCurveRouter.TokenCreationParams",
        components: [
          { name: "name", type: "string", internalType: "string" },
          { name: "symbol", type: "string", internalType: "string" },
          { name: "tokenURI", type: "string", internalType: "string" },
          { name: "amountOut", type: "uint256", internalType: "uint256" },
          { name: "salt", type: "bytes32", internalType: "bytes32" },
          { name: "actionId", type: "uint8", internalType: "uint8" },
        ],
      },
    ],
    outputs: [
      { name: "token", type: "address", internalType: "address" },
      { name: "pool", type: "address", internalType: "address" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "buy",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IBondingCurveRouter.BuyParams",
        components: [
          { name: "amountOutMin", type: "uint256", internalType: "uint256" },
          { name: "token", type: "address", internalType: "address" },
          { name: "to", type: "address", internalType: "address" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "sell",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IBondingCurveRouter.SellParams",
        components: [
          { name: "amountIn", type: "uint256", internalType: "uint256" },
          { name: "amountOutMin", type: "uint256", internalType: "uint256" },
          { name: "token", type: "address", internalType: "address" },
          { name: "to", type: "address", internalType: "address" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "buy",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IRouter.BuyParams",
        components: [
          { name: "amountOutMin", type: "uint256", internalType: "uint256" },
          { name: "token", type: "address", internalType: "address" },
          { name: "to", type: "address", internalType: "address" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "sell",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IRouter.SellParams",
        components: [
          { name: "amountIn", type: "uint256", internalType: "uint256" },
          { name: "amountOutMin", type: "uint256", internalType: "uint256" },
          { name: "token", type: "address", internalType: "address" },
          { name: "to", type: "address", internalType: "address" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const;
