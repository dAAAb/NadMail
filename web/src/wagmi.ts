import { createConfig, http } from 'wagmi';
import { injected, coinbaseWallet, walletConnect } from 'wagmi/connectors';

// Monad chain definition
const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://monad-mainnet.drpc.org'] },
  },
  blockExplorers: {
    default: { name: 'MonadExplorer', url: 'https://explorer.monad.xyz' },
  },
} as const;

export const config = createConfig({
  chains: [monad],
  connectors: [
    injected(),
    walletConnect({ projectId: 'add5558996c46a35e9f43542dc4eba29' }),
    coinbaseWallet({ appName: 'NadMail' }),
  ],
  transports: {
    [monad.id]: http(),
  },
});
