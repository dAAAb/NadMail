import { createConfig, http } from 'wagmi';
import { base, mainnet, baseSepolia } from 'wagmi/chains';
import { injected, coinbaseWallet, walletConnect } from 'wagmi/connectors';

export const config = createConfig({
  chains: [base, mainnet, baseSepolia],
  connectors: [
    coinbaseWallet({ appName: 'BaseMail' }),   // Primary — 放第一位
    walletConnect({ projectId: 'add5558996c46a35e9f43542dc4eba29' }),
    injected(),                                  // Fallback for browser extensions
  ],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
    [baseSepolia.id]: http(),
  },
});
