import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAccount, useConnect, useDisconnect, useSignMessage, useSendTransaction, useBalance, useSwitchChain } from 'wagmi';
import { parseEther, formatUnits, encodeFunctionData, parseAbi, toHex } from 'viem';
import { base, mainnet } from 'wagmi/chains';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';

const API_BASE = import.meta.env.PROD ? 'https://api.basemail.ai' : '';
const DEPOSIT_ADDRESS = '0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe';

// USDC Hackathon — Base Sepolia Testnet
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

interface EmailItem {
  id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  read: number;
  created_at: number;
  usdc_amount?: string | null;
  usdc_tx?: string | null;
}

interface AuthState {
  token: string;
  wallet: string;
  handle: string | null;
  registered: boolean;
  basename?: string | null;
  tier?: 'free' | 'pro';
  suggested_handle?: string | null;
  suggested_source?: string | null;
  suggested_email?: string | null;
  pending_emails?: number;
  upgrade_available?: boolean;
  has_basename_nft?: boolean;
}


// ─── Animated Spinner ────────────────────────────────────
function ChainSearchSpinner({ maxSeconds = 30 }: { maxSeconds?: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const progress = Math.min(elapsed / maxSeconds, 1);
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="relative w-8 h-8">
        <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="13" fill="none" stroke="#374151" strokeWidth="3" />
          <circle cx="16" cy="16" r="13" fill="none" stroke="#3b82f6" strokeWidth="3"
            strokeDasharray={`${progress * 81.68} 81.68`}
            strokeLinecap="round" className="transition-all duration-1000" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-gray-400">
          {elapsed}s
        </span>
      </div>
      <div className="text-xs text-gray-400">
        <span className="inline-flex">
          Verifying on-chain
          <span className="animate-pulse">...</span>
        </span>
        <div className="text-[10px] text-gray-600 mt-0.5">
          {elapsed < 5 ? 'Checking Base...' : elapsed < 15 ? 'Checking ETH Mainnet...' : 'Waiting for confirmation...'}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

function apiFetch(path: string, token: string, opts: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
}

function truncateEmail(handle: string): string {
  if (handle.length <= 20) return `${handle}@basemail.ai`;
  return `${handle.slice(0, 6)}...${handle.slice(-4)}@basemail.ai`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="text-gray-500 hover:text-base-blue transition text-xs flex items-center gap-1"
      title="Copy to clipboard"
    >
      {copied ? 'Copied!' : (label || 'Copy')}
    </button>
  );
}

function ConfettiEffect() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-50">
      {Array.from({ length: 50 }).map((_, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: `${Math.random() * 100}%`,
            top: `-10%`,
            width: `${6 + Math.random() * 8}px`,
            height: `${6 + Math.random() * 8}px`,
            backgroundColor: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'][Math.floor(Math.random() * 5)],
            borderRadius: Math.random() > 0.5 ? '50%' : '0',
            animation: `confetti-fall ${2 + Math.random() * 2}s ease-out forwards`,
            animationDelay: `${Math.random() * 0.5}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// Decode quoted-printable encoded strings
function decodeQuotedPrintable(str: string): string {
  // Remove soft line breaks (= at end of line)
  let decoded = str.replace(/=\r?\n/g, '');
  // Decode =XX hex sequences
  decoded = decoded.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Try to decode as UTF-8
  try {
    const bytes = new Uint8Array([...decoded].map(c => c.charCodeAt(0)));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return decoded;
  }
}

// Extract readable text from raw MIME
function extractTextFromMime(raw: string): string {
  if (!raw) return '';

  // If multipart, extract text/plain part
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split('--' + boundary);
    for (const part of parts) {
      if (part.toLowerCase().includes('content-type: text/plain')) {
        const isQP = part.toLowerCase().includes('quoted-printable');
        const sep = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
        const bodyStart = part.indexOf(sep);
        if (bodyStart !== -1) {
          let body = part.slice(bodyStart + sep.length).trim();
          // Remove trailing boundary markers
          body = body.replace(/--$/, '').trim();
          return isQP ? decodeQuotedPrintable(body) : body;
        }
      }
    }
  }

  // Single part — check for quoted-printable
  const isQP = raw.toLowerCase().includes('content-transfer-encoding: quoted-printable');
  const sep = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const headerEnd = raw.indexOf(sep);
  if (headerEnd === -1) return raw;
  let body = raw.slice(headerEnd + sep.length).trim();
  return isQP ? decodeQuotedPrintable(body) : body;
}

// Clean snippet for inbox list (strip MIME artifacts + decode QP)
function cleanSnippet(snippet: string | null): string {
  if (!snippet) return '';
  // Remove MIME boundary lines and headers from snippet
  let clean = snippet
    .replace(/--[0-9a-f]+\s*/gi, '')
    .replace(/Content-Type:[^\n]+/gi, '')
    .replace(/Content-Transfer-Encoding:[^\n]+/gi, '')
    .replace(/charset="?[^"\s]+"?/gi, '')
    .trim();
  if (clean.length === 0) return snippet.slice(0, 100);
  // Decode quoted-printable if present
  if (/=[0-9A-Fa-f]{2}/.test(clean)) {
    clean = decodeQuotedPrintable(clean);
  }
  return clean;
}

// ─── Main Dashboard ──────────────────────────────────────

export default function Dashboard() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const saved = sessionStorage.getItem('basemail_auth');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (auth) {
      sessionStorage.setItem('basemail_auth', JSON.stringify(auth));
    } else {
      sessionStorage.removeItem('basemail_auth');
    }
  }, [auth]);

  const location = useLocation();
  const { disconnect } = useDisconnect();
  const [showAltEmail, setShowAltEmail] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [showUpgradeConfetti, setShowUpgradeConfetti] = useState(false);
  const [basenameInput, setBasenameInput] = useState('');
  const [upgradeError, setUpgradeError] = useState('');

  // Wallet balances for sidebar display
  const walletAddr = auth?.wallet as `0x${string}` | undefined;
  const { data: baseEth } = useBalance({ address: walletAddr, chainId: base.id });
  const { data: mainnetEth } = useBalance({ address: walletAddr, chainId: mainnet.id });
  const { data: baseUsdc } = useBalance({ address: walletAddr, chainId: base.id, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
  const { data: mainnetUsdc } = useBalance({ address: walletAddr, chainId: mainnet.id, token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });

  // USDC Hackathon — Base Sepolia testnet balances
  const { data: sepoliaEth } = useBalance({ address: walletAddr, chainId: BASE_SEPOLIA_CHAIN_ID });
  const { data: sepoliaUsdc } = useBalance({ address: walletAddr, chainId: BASE_SEPOLIA_CHAIN_ID, token: BASE_SEPOLIA_USDC });

  // USDC Send modal state
  const [showUsdcSend, setShowUsdcSend] = useState(false);

  // Auto-detect Basename upgrade for 0x handle users
  useEffect(() => {
    if (!auth?.registered || !auth.handle || !/^0x/i.test(auth.handle)) return;
    if (auth.upgrade_available || auth.has_basename_nft) return; // Already checked

    fetch(`${API_BASE}/api/register/check/${auth.wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.basename && data.source === 'basename') {
          // Reverse resolution found the name
          setAuth(prev => prev ? {
            ...prev,
            basename: data.basename,
            suggested_handle: data.handle,
            suggested_source: data.source,
            suggested_email: data.email,
            upgrade_available: true,
          } : prev);
        } else if (data.has_basename_nft) {
          // User owns a Basename NFT but reverse resolution isn't set
          // Show manual input for the user to type their Basename
          setAuth(prev => prev ? {
            ...prev,
            has_basename_nft: true,
            upgrade_available: true,
          } : prev);
        }
      })
      .catch(() => {});
  }, [auth?.handle, auth?.wallet]);

  if (!auth) {
    return <ConnectWallet onAuth={setAuth} />;
  }

  if (!auth.registered || !auth.handle) {
    return (
      <RegisterEmail
        auth={auth}
        onRegistered={(handle, token) => setAuth({ ...auth, handle, registered: true, token })}
      />
    );
  }

  const hasBasename = !!auth.basename && !/^0x/i.test(auth.handle!);
  // Can upgrade: either reverse resolution found the name, or we know they have a Basename NFT
  const hasKnownName = auth.suggested_handle && /^0x/i.test(auth.handle!);
  const hasNFTOnly = auth.has_basename_nft && /^0x/i.test(auth.handle!) && !auth.suggested_handle;
  const canUpgrade = auth.upgrade_available && (hasKnownName || hasNFTOnly);
  const primaryEmail = `${auth.handle}@basemail.ai`;
  const altEmail = hasBasename ? `${auth.wallet.toLowerCase()}@basemail.ai` : null;
  const displayEmail = showAltEmail && altEmail ? altEmail : primaryEmail;

  async function handleUpgrade(overrideBasename?: string) {
    const basename = overrideBasename || auth.basename;
    if (!basename && !basenameInput.trim()) {
      setUpgradeError('Please enter your Basename');
      return;
    }

    // Build the basename string
    let fullBasename = basename || basenameInput.trim();
    if (!fullBasename.endsWith('.base.eth')) {
      fullBasename = `${fullBasename}.base.eth`;
    }

    setUpgrading(true);
    setUpgradeError('');
    try {
      const res = await apiFetch('/api/register/upgrade', auth!.token, {
        method: 'PUT',
        body: JSON.stringify({ basename: fullBasename }),
      });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { throw new Error(`Server error: ${text.slice(0, 100)}`); }
      if (!res.ok) throw new Error(data.error);
      setShowUpgradeConfetti(true);
      setTimeout(() => {
        setShowUpgradeConfetti(false);
        setAuth({
          ...auth,
          handle: data.handle,
          token: data.token,
          basename: data.basename,
          upgrade_available: false,
          has_basename_nft: false,
        });
      }, 3500);
    } catch (e: any) {
      setUpgradeError(e.message || 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  }

  return (
    <div className="min-h-screen bg-base-dark flex">
      {showUpgradeConfetti && <ConfettiEffect />}

      {/* Sidebar */}
      <aside className="w-64 bg-base-gray border-r border-gray-800 p-6 flex flex-col">
        <Link to="/" className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 bg-base-blue rounded-lg flex items-center justify-center text-white font-bold text-sm">
            BM
          </div>
          <span className="text-lg font-bold">BaseMail</span>
        </Link>

        {/* Email address card — with toggle for basename users */}
        <div className="bg-base-dark rounded-lg p-3 mb-6">
          <div className="text-gray-400 text-xs mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1">
              {showAltEmail ? '0x Address' : 'Your Email'}
              {auth.tier === 'pro' && <span title="BaseMail Pro" style={{ color: '#FFD700' }}>&#10003;</span>}
            </span>
            {altEmail && (
              <button
                onClick={() => setShowAltEmail(!showAltEmail)}
                className="text-gray-600 hover:text-base-blue transition text-xs"
                title={showAltEmail ? 'Show Basename' : 'Show 0x address'}
              >
                &#x21C4;
              </button>
            )}
          </div>
          <div className="text-base-blue font-mono text-sm truncate" title={displayEmail}>
            {showAltEmail && altEmail ? truncateEmail(auth.wallet.toLowerCase()) : truncateEmail(auth.handle!)}
          </div>
          <CopyButton text={displayEmail} label="Copy address" />
          {altEmail && (
            <div className="text-gray-600 text-xs mt-1">
              {showAltEmail ? 'Both addresses receive mail' : `Also: ${truncateEmail(auth.wallet.toLowerCase())}`}
            </div>
          )}
        </div>

        {/* Basename upgrade prompt */}
        {canUpgrade && hasKnownName && (
          <button
            onClick={() => handleUpgrade()}
            disabled={upgrading}
            className="bg-gradient-to-r from-blue-600 to-purple-600 text-white text-xs py-2 px-3 rounded-lg mb-4 hover:from-blue-500 hover:to-purple-500 transition disabled:opacity-50 text-center"
          >
            {upgrading ? 'Upgrading...' : `\u2728 Upgrade to ${auth.suggested_handle}@basemail.ai`}
          </button>
        )}
        {canUpgrade && hasNFTOnly && (
          <div className="bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-700/50 rounded-lg p-3 mb-4 text-xs">
            <span className="text-blue-300 font-bold">Basename Detected!</span>
          </div>
        )}

        <nav className="flex-1 space-y-1">
          <NavLink to="/dashboard" icon="inbox" label="Inbox" active={location.pathname === '/dashboard'} />
          <NavLink to="/dashboard/sent" icon="send" label="Sent" active={location.pathname === '/dashboard/sent'} />
          <NavLink to="/dashboard/compose" icon="edit" label="Compose" active={location.pathname === '/dashboard/compose'} />
          <NavLink to="/dashboard/credits" icon="credits" label="Credits" active={location.pathname === '/dashboard/credits'} />
          <NavLink to="/dashboard/settings" icon="settings" label="Settings" active={location.pathname === '/dashboard/settings'} />
        </nav>

        <div className="mt-auto pt-6 border-t border-gray-800">
          {/* Wallet balances */}
          <div className="mb-3 space-y-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Balances</div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Base ETH</span>
              <span className="text-gray-300 font-mono">{baseEth ? parseFloat(formatUnits(baseEth.value, 18)).toFixed(4) : '—'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Base USDC</span>
              <span className="text-gray-300 font-mono">{baseUsdc ? parseFloat(formatUnits(baseUsdc.value, 6)).toFixed(2) : '—'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">ETH Main</span>
              <span className="text-gray-300 font-mono">{mainnetEth ? parseFloat(formatUnits(mainnetEth.value, 18)).toFixed(4) : '—'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Main USDC</span>
              <span className="text-gray-300 font-mono">{mainnetUsdc ? parseFloat(formatUnits(mainnetUsdc.value, 6)).toFixed(2) : '—'}</span>
            </div>
          </div>
          {/* USDC Hackathon Box */}
          <div className="mb-3 border border-dashed border-purple-700/50 rounded-lg p-2.5 bg-purple-900/10">
            <div className="flex items-center justify-between mb-1.5">
              <a href="https://www.moltbook.com/m/usdc" target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-purple-400 hover:text-purple-300 uppercase tracking-wider font-bold">
                USDC Hackathon
              </a>
              <span className="text-[9px] text-purple-600 bg-purple-900/30 px-1.5 py-0.5 rounded">TESTNET</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noopener noreferrer"
                  className="text-gray-500 hover:text-purple-400 transition underline decoration-dotted cursor-pointer" title="Get free testnet ETH">Sepolia ETH</a>
                <span className="text-gray-300 font-mono">{sepoliaEth ? parseFloat(formatUnits(sepoliaEth.value, 18)).toFixed(4) : '—'}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer"
                  className="text-gray-500 hover:text-purple-400 transition underline decoration-dotted cursor-pointer" title="Get free testnet USDC">Sepolia USDC</a>
                <span className="text-gray-300 font-mono">{sepoliaUsdc ? parseFloat(formatUnits(sepoliaUsdc.value, 6)).toFixed(2) : '—'}</span>
              </div>
            </div>
            <button
              onClick={() => setShowUsdcSend(true)}
              className="mt-2 w-full bg-purple-700/30 hover:bg-purple-700/50 text-purple-300 text-xs py-1.5 rounded-md transition flex items-center justify-center gap-1.5"
            >
              <span style={{ fontSize: '14px' }}>&#9993;</span> Send USDC
            </button>
          </div>

          <div className="text-xs text-gray-500 font-mono truncate mb-2" title={auth.wallet}>
            {auth.wallet.slice(0, 6)}...{auth.wallet.slice(-4)}
          </div>
          <button
            onClick={() => {
              sessionStorage.removeItem('basemail_auth');
              disconnect();
              setAuth(null);
            }}
            className="text-xs text-gray-600 hover:text-red-400 transition"
          >
            Disconnect
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8 overflow-y-auto">
        {/* Basename upgrade banner at top */}
        {canUpgrade && hasKnownName && (
          <div className="bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-700/50 rounded-xl p-5 mb-6 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">&#10024;</span>
                <h3 className="font-bold text-lg">Basename Detected!</h3>
              </div>
              <p className="text-gray-400 text-sm">
                You own <span className="text-base-blue font-medium">{auth.basename}</span> — upgrade your email from{' '}
                <span className="font-mono text-gray-500 text-xs">{truncateEmail(auth.handle!)}</span> to{' '}
                <span className="text-base-blue font-bold">{auth.suggested_handle}@basemail.ai</span>
              </p>
            </div>
            <button
              onClick={() => handleUpgrade()}
              disabled={upgrading}
              className="bg-base-blue text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-500 transition disabled:opacity-50 whitespace-nowrap text-sm"
            >
              {upgrading ? 'Upgrading...' : '\u2728 Claim Basename Email'}
            </button>
          </div>
        )}
        {canUpgrade && hasNFTOnly && (
          <div className="bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-700/50 rounded-xl p-5 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">&#10024;</span>
              <h3 className="font-bold text-lg">You own a Basename!</h3>
            </div>
            <p className="text-gray-400 text-sm mb-4">
              We detected a Basename NFT in your wallet. Enter your Basename to upgrade your email.
            </p>
            <div className="flex gap-3">
              <div className="flex-1 flex items-center bg-base-dark rounded-lg border border-gray-700 px-3">
                <input
                  type="text"
                  value={basenameInput}
                  onChange={(e) => { setBasenameInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setUpgradeError(''); }}
                  placeholder="yourname"
                  className="flex-1 bg-transparent py-3 text-white font-mono focus:outline-none"
                />
                <span className="text-gray-500 font-mono text-sm">.base.eth</span>
              </div>
              <button
                onClick={() => handleUpgrade()}
                disabled={upgrading || !basenameInput.trim()}
                className="bg-base-blue text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-500 transition disabled:opacity-50 whitespace-nowrap text-sm"
              >
                {upgrading ? 'Verifying...' : '\u2728 Claim Email'}
              </button>
            </div>
            {upgradeError && <p className="text-red-400 text-sm mt-2">{upgradeError}</p>}
          </div>
        )}

        <Routes>
          <Route index element={<Inbox auth={auth} folder="inbox" />} />
          <Route path="sent" element={<Inbox auth={auth} folder="sent" />} />
          <Route path="compose" element={<Compose auth={auth} />} />
          <Route path="credits" element={<Credits auth={auth} />} />
          <Route path="settings" element={<Settings auth={auth} setAuth={setAuth} onUpgrade={(canUpgrade || hasNFTOnly) ? handleUpgrade : undefined} upgrading={upgrading} />} />
          <Route path="email/:id" element={<EmailDetail auth={auth} />} />
        </Routes>
      </main>

      {/* USDC Send Modal */}
      {showUsdcSend && auth.handle && (
        <UsdcSendModal auth={auth} onClose={() => setShowUsdcSend(false)} />
      )}
    </div>
  );
}

// ─── USDC Send Modal (Base Sepolia Testnet) ────────────
function UsdcSendModal({ auth, onClose }: { auth: AuthState; onClose: () => void }) {
  const { switchChainAsync } = useSwitchChain();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [recipientWallet, setRecipientWallet] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [status, setStatus] = useState<'idle' | 'switching' | 'transferring' | 'confirming' | 'sending_email' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState('');
  const { writeContractAsync } = useWriteContract();

  // Resolve recipient handle → wallet
  useEffect(() => {
    if (!recipient || recipient.length < 2) {
      setRecipientWallet('');
      setResolveError('');
      return;
    }
    const handle = recipient.replace(/@basemail\.ai$/i, '').toLowerCase();
    const timeout = setTimeout(async () => {
      setResolving(true);
      setResolveError('');
      try {
        const res = await fetch(`${API_BASE}/api/identity/${handle}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Not found');
        setRecipientWallet(data.wallet);
      } catch {
        setRecipientWallet('');
        setResolveError('Recipient not found');
      } finally {
        setResolving(false);
      }
    }, 500);
    return () => clearTimeout(timeout);
  }, [recipient]);

  async function handleSend() {
    if (!recipientWallet || !amount || parseFloat(amount) <= 0) return;
    setError('');

    try {
      // 1. Switch to Base Sepolia
      setStatus('switching');
      await switchChainAsync({ chainId: BASE_SEPOLIA_CHAIN_ID });

      // 2. Transfer USDC
      setStatus('transferring');
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 1e6));
      const handle = recipient.replace(/@basemail\.ai$/i, '').toLowerCase();
      const memo = new TextEncoder().encode(`basemail:${handle}@basemail.ai`);
      const memoHex = Array.from(memo).map(b => b.toString(16).padStart(2, '0')).join('');

      // Encode transfer + append memo as extra calldata
      const transferData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [recipientWallet as `0x${string}`, amountRaw],
      });
      const fullData = (transferData + memoHex) as `0x${string}`;

      const hash = await writeContractAsync({
        address: BASE_SEPOLIA_USDC,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [recipientWallet as `0x${string}`, amountRaw],
        chainId: BASE_SEPOLIA_CHAIN_ID,
        // Use raw data with memo appended
        dataSuffix: `0x${memoHex}` as `0x${string}`,
      });
      setTxHash(hash);

      // 3. Wait for confirmation + send verified payment email
      setStatus('sending_email');
      const emailTo = handle.startsWith('0x') ? `${handle}@basemail.ai` : `${handle}@basemail.ai`;
      const res = await apiFetch('/api/send', auth.token, {
        method: 'POST',
        body: JSON.stringify({
          to: emailTo,
          subject: `USDC Payment: $${parseFloat(amount).toFixed(2)}`,
          body: `You received a payment of ${parseFloat(amount).toFixed(2)} USDC on Base Sepolia (testnet).\n\nTransaction: https://sepolia.basescan.org/tx/${hash}\n\nSent via BaseMail.ai`,
          usdc_payment: { tx_hash: hash, amount: parseFloat(amount).toFixed(2) },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send payment email');

      setStatus('success');
    } catch (e: any) {
      setError(e.message || 'Transaction failed');
      setStatus('error');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-base-gray rounded-xl p-6 max-w-md w-full border border-purple-700/50 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold">Send USDC</h3>
            <span className="text-[10px] text-purple-400 bg-purple-900/30 px-2 py-0.5 rounded">Base Sepolia Testnet</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">&times;</button>
        </div>

        {status === 'success' ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">$</div>
            <h4 className="text-xl font-bold text-green-400 mb-2">Payment Sent!</h4>
            <p className="text-gray-400 text-sm mb-2">
              {parseFloat(amount).toFixed(2)} USDC sent to {recipient}
            </p>
            {txHash && (
              <a
                href={`https://sepolia.basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 text-xs underline"
              >
                View on BaseScan
              </a>
            )}
            <button
              onClick={onClose}
              className="mt-4 w-full bg-purple-600 text-white py-3 rounded-lg font-medium hover:bg-purple-500 transition"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Recipient */}
            <div className="mb-4">
              <label className="text-gray-400 text-xs mb-1 block">Recipient</label>
              <input
                type="text"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.toLowerCase().trim())}
                placeholder="handle or handle@basemail.ai"
                className="w-full bg-base-dark border border-gray-700 rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-purple-500"
              />
              {resolving && <p className="text-gray-500 text-xs mt-1">Resolving...</p>}
              {resolveError && <p className="text-red-400 text-xs mt-1">{resolveError}</p>}
              {recipientWallet && (
                <p className="text-green-500 text-xs mt-1 font-mono">
                  {recipientWallet.slice(0, 6)}...{recipientWallet.slice(-4)}
                </p>
              )}
            </div>

            {/* Amount */}
            <div className="mb-4">
              <label className="text-gray-400 text-xs mb-1 block">Amount (USDC)</label>
              <input
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="10.00"
                className="w-full bg-base-dark border border-gray-700 rounded-lg px-3 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            {/* Info */}
            <div className="bg-base-dark rounded-lg p-3 mb-4 text-xs text-gray-500 space-y-1">
              <p>Payment goes directly to recipient's wallet on Base Sepolia.</p>
              <p>A verified payment email will be sent automatically.</p>
              <p className="text-purple-400">On-chain memo: basemail:{recipient || '...'}@basemail.ai</p>
            </div>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!recipientWallet || !amount || parseFloat(amount) <= 0 || status !== 'idle' && status !== 'error'}
              className="w-full bg-purple-600 text-white py-3 rounded-lg font-medium hover:bg-purple-500 transition disabled:opacity-50"
            >
              {status === 'switching' ? 'Switching to Base Sepolia...'
                : status === 'transferring' ? 'Confirm in wallet...'
                : status === 'confirming' ? 'Waiting for confirmation...'
                : status === 'sending_email' ? 'Sending payment email...'
                : `Send ${amount || '0'} USDC`}
            </button>

            {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function NavLink({ to, icon, label, active }: { to: string; icon: string; label: string; active: boolean }) {
  const icons: Record<string, string> = {
    inbox: '\u{1F4E5}',
    send: '\u{1F4E4}',
    edit: '\u{270F}\u{FE0F}',
    settings: '\u{2699}\u{FE0F}',
    credits: '\u{1FA99}',
  };
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
        active ? 'bg-base-blue/10 text-base-blue' : 'text-gray-400 hover:text-white hover:bg-gray-800'
      }`}
    >
      <span>{icons[icon]}</span>
      {label}
    </Link>
  );
}

// ─── Connect Wallet ─────────────────────────────────────
function ConnectWallet({ onAuth }: { onAuth: (auth: AuthState) => void }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const doSiwe = useCallback(async (addr: string) => {
    try {
      setStatus('Preparing sign-in...');
      setError('');

      // 2-step flow: POST /start → sign → POST /verify
      const startRes = await fetch(`${API_BASE}/api/auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      if (!startRes.ok) {
        const err = await startRes.json();
        throw new Error(err.error || 'Failed to start authentication');
      }
      const { message } = await startRes.json();

      setStatus('Please sign the message in your wallet...');
      const signature = await signMessageAsync({ message });

      setStatus('Verifying...');
      const verifyRes = await fetch(`${API_BASE}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, signature, message }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'Verification failed');
      }

      const data = await verifyRes.json();
      onAuth({
        token: data.token,
        wallet: data.wallet,
        handle: data.handle,
        registered: data.registered,
        basename: data.basename,
        tier: data.tier || 'free',
        suggested_handle: data.suggested_handle,
        suggested_source: data.suggested_source,
        suggested_email: data.suggested_email,
        pending_emails: data.pending_emails || 0,
        upgrade_available: data.upgrade_available || false,
        has_basename_nft: data.has_basename_nft || false,
      });
    } catch (e: any) {
      setError(e.message || 'Authentication failed');
      setStatus('');
    }
  }, [signMessageAsync, onAuth]);

  useEffect(() => {
    if (isConnected && address && !status) {
      doSiwe(address);
    }
  }, [isConnected, address]);

  return (
    <div className="min-h-screen bg-base-dark flex items-center justify-center">
      <div className="bg-base-gray rounded-xl p-8 max-w-md w-full text-center border border-gray-800">
        <div className="w-16 h-16 bg-base-blue rounded-xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-6">
          BM
        </div>
        <h1 className="text-2xl font-bold mb-2">BaseMail Dashboard</h1>
        <p className="text-gray-400 mb-8">Connect your Base wallet to access your agent's email.</p>

        {error && (
          <div className="bg-red-900/20 border border-red-800 text-red-400 text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        {status ? (
          <div className="text-base-blue text-sm font-mono py-3">{status}</div>
        ) : (
          <div className="space-y-3">
            {connectors.map((connector) => {
              const isCoinbase = connector.id === 'coinbaseWalletSDK';
              // 隱藏重複：Coinbase Smart Wallet 會 inject window.ethereum
              if (connector.id === 'injected' && connector.name === 'Coinbase Wallet') return null;
              // 隱藏 injected 如果沒有瀏覽器錢包（WalletConnect 已覆蓋）
              if (connector.id === 'injected' && typeof window !== 'undefined' && !(window as any).ethereum) return null;

              return (
                <button
                  key={connector.uid}
                  onClick={() => connect({ connector })}
                  disabled={isConnecting}
                  className={isCoinbase
                    ? 'w-full bg-base-blue text-white py-3 rounded-lg font-medium hover:bg-blue-600 transition disabled:opacity-50'
                    : 'w-full bg-transparent text-white py-3 rounded-lg font-medium border border-gray-600 hover:border-base-blue hover:text-base-blue transition disabled:opacity-50'
                  }
                >
                  {isConnecting ? 'Connecting...' : `Connect with ${connector.name}`}
                </button>
              );
            })}
          </div>
        )}

        <p className="text-gray-600 text-xs mt-6">
          Sign-In with Ethereum (SIWE) — No passwords, no CAPTCHAs
        </p>
      </div>
    </div>
  );
}

// ─── Register Email ─────────────────────────────────────
function RegisterEmail({
  auth,
  onRegistered,
}: {
  auth: AuthState;
  onRegistered: (handle: string, token: string) => void;
}) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [claimedHandle, setClaimedHandle] = useState('');

  const suggestedEmail = auth.suggested_email || `${auth.wallet}@basemail.ai`;
  const isBasename = auth.suggested_source === 'basename';
  const shortAddr = auth.wallet ? `${auth.wallet.slice(0, 6)}...${auth.wallet.slice(-4)}` : '';

  async function handleRegister() {
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/register', auth.token, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setClaimedHandle(data.handle);
      setClaimed(true);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Success screen after claim
  if (claimed) {
    const claimedEmail = `${claimedHandle}@basemail.ai`;
    const altEmail = `${auth.wallet.toLowerCase()}@basemail.ai`;
    const hasAlt = claimedHandle !== auth.wallet.toLowerCase();

    return (
      <div className="min-h-screen bg-base-dark flex items-center justify-center">
        {showConfetti && <ConfettiEffect />}

        <div className="bg-base-gray rounded-xl p-8 max-w-md w-full border border-gray-800 text-center">
          <div className="text-5xl mb-4">&#127881;</div>
          <h1 className="text-2xl font-bold text-base-blue mb-1 break-all">
            {claimedEmail}
          </h1>
          <p className="text-green-400 font-medium text-lg mb-6">is yours!</p>

          {hasAlt && (
            <div className="bg-base-dark rounded-lg p-4 mb-6 border border-gray-700 text-left">
              <div className="text-gray-500 text-xs mb-2">Also receives email at:</div>
              <div className="font-mono text-sm text-gray-300 break-all">
                {altEmail}
              </div>
              <div className="text-gray-600 text-xs mt-1">
                Both addresses deliver to the same inbox.
              </div>
            </div>
          )}

          <button
            disabled
            className="w-full bg-gray-700 text-gray-400 py-3 rounded-lg font-medium mb-3 cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span>&#127941;</span> Claim NFT Badge (Coming Soon)
          </button>

          <button
            onClick={() => onRegistered(claimedHandle, auth.token)}
            className="w-full bg-base-blue text-white py-3 rounded-lg font-medium hover:bg-blue-600 transition text-lg"
          >
            Enter Inbox &#8594;
          </button>
        </div>
      </div>
    );
  }

  // Claim screen
  return (
    <div className="min-h-screen bg-base-dark flex items-center justify-center">
      <div className="bg-base-gray rounded-xl p-8 max-w-md w-full border border-gray-800">
        {isBasename ? (
          <>
            <div className="text-center mb-6">
              <div className="text-5xl mb-4">&#10024;</div>
              <h1 className="text-2xl font-bold mb-2">Basename Detected!</h1>
              <p className="text-gray-400">
                Your Basename <span className="text-base-blue font-medium">{auth.basename}</span> is linked to this wallet.
              </p>
            </div>

            <div className="bg-base-dark rounded-lg p-5 mb-6 border border-gray-700 text-center">
              <div className="text-gray-500 text-xs mb-2">Your Email Address</div>
              <div className="text-2xl font-mono text-base-blue font-bold">
                {suggestedEmail}
              </div>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold mb-2">Claim Your Email</h1>
            <p className="text-gray-400 mb-6">
              Your wallet address will be your email identity.
            </p>

            <div className="bg-base-dark rounded-lg p-4 mb-4 border border-gray-700">
              <div className="text-gray-500 text-xs mb-2">Your Email Address</div>
              <div className="text-xl font-mono text-base-blue font-bold break-all">
                {suggestedEmail}
              </div>
              <div className="text-gray-500 text-xs mt-2">
                Wallet: <span className="text-gray-300">{shortAddr}</span>
              </div>
            </div>
          </>
        )}

        {auth.pending_emails && auth.pending_emails > 0 ? (
          <div className="bg-blue-900/20 border border-blue-800 text-blue-300 text-sm rounded-lg p-3 mb-4">
            You have <span className="font-bold">{auth.pending_emails}</span> email{auth.pending_emails > 1 ? 's' : ''} waiting for you!
          </div>
        ) : null}

        {!isBasename && (
          <div className="bg-gray-800/50 rounded-lg p-3 mb-4 text-xs text-gray-400">
            No Basename detected. You can upgrade your email later by registering a{' '}
            <a href="https://www.base.org/names" target="_blank" rel="noopener noreferrer" className="text-base-blue hover:underline">
              Basename
            </a>.
          </div>
        )}

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        <button
          onClick={handleRegister}
          disabled={submitting}
          className="w-full bg-base-blue text-white py-3 rounded-lg font-medium hover:bg-blue-600 transition disabled:opacity-50 text-lg"
        >
          {submitting ? 'Claiming...' : isBasename ? '\u2728 Claim My Email' : 'Claim Email'}
        </button>
      </div>
    </div>
  );
}

// ─── Inbox / Sent ───────────────────────────────────────
function Inbox({ auth, folder }: { auth: AuthState; folder: string }) {
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/inbox?folder=${folder}&limit=50`, auth.token)
      .then((r) => r.json())
      .then((data) => {
        setEmails(data.emails || []);
        setTotal(data.total || 0);
        setUnread(data.unread || 0);
      })
      .catch(() => setEmails([]))
      .finally(() => setLoading(false));
  }, [folder, auth.token]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          {folder === 'inbox' ? 'Inbox' : 'Sent'}
          {unread > 0 && (
            <span className="ml-2 text-sm bg-base-blue text-white px-2 py-0.5 rounded-full">
              {unread}
            </span>
          )}
        </h2>
        <span className="text-gray-500 text-sm">{total} emails</span>
      </div>

      {loading ? (
        <div className="text-gray-500 text-center py-20">Loading...</div>
      ) : emails.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-4xl mb-4">{folder === 'inbox' ? '\u{1F4ED}' : '\u{1F4E4}'}</p>
          <p>No emails yet</p>
        </div>
      ) : (
        <div className="space-y-1">
          {emails.map((email) => (
            <Link
              key={email.id}
              to={`/dashboard/email/${email.id}`}
              className={`block px-4 py-3 rounded-lg hover:bg-base-gray transition ${
                !email.read ? 'bg-base-gray/50' : ''
              }`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${!email.read ? 'bg-base-blue' : 'bg-transparent'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`font-mono text-sm truncate ${!email.read ? 'text-white font-bold' : 'text-gray-400'}`}>
                      {folder === 'inbox' ? email.from_addr : email.to_addr}
                    </span>
                    <span className="text-gray-600 text-xs flex-shrink-0 ml-4">
                      {new Date(email.created_at * 1000).toLocaleString()}
                    </span>
                  </div>
                  <div className={`text-sm flex items-center gap-2 ${!email.read ? 'text-white' : 'text-gray-400'}`}>
                    {email.usdc_amount && (
                      <span className="text-green-400 text-xs font-bold bg-green-900/30 px-1.5 py-0.5 rounded" title="Verified USDC Payment">
                        ${email.usdc_amount}
                      </span>
                    )}
                    {email.subject || '(no subject)'}
                  </div>
                  <div className="text-gray-600 text-xs truncate mt-1">{cleanSnippet(email.snippet)}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Email Detail ───────────────────────────────────────
function EmailDetail({ auth }: { auth: AuthState }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiFetch(`/api/inbox/${id}`, auth.token)
      .then((r) => r.json())
      .then(setEmail)
      .catch(() => setEmail(null))
      .finally(() => setLoading(false));
  }, [id, auth.token]);

  async function handleDelete() {
    if (!confirm('Delete this email?')) return;
    setDeleting(true);
    await apiFetch(`/api/inbox/${id}`, auth.token, { method: 'DELETE' });
    navigate('/dashboard');
  }

  if (loading) {
    return <div className="text-gray-500 text-center py-20">Loading...</div>;
  }

  if (!email || email.error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 mb-4">Email not found</p>
        <Link to="/dashboard" className="text-base-blue hover:underline">Back to Inbox</Link>
      </div>
    );
  }

  const bodyText = extractTextFromMime(email.body || '');

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Link to="/dashboard" className="text-gray-400 hover:text-white text-sm">
          &larr; Back
        </Link>
        <div className="flex-1" />
        <Link
          to={`/dashboard/compose?reply=${id}&to=${encodeURIComponent(email.from_addr)}&subject=${encodeURIComponent('Re: ' + (email.subject || ''))}`}
          className="text-base-blue hover:underline text-sm"
        >
          Reply
        </Link>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>

      <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
        <h2 className="text-xl font-bold mb-4">{email.subject || '(no subject)'}</h2>

        {/* Verified USDC Payment banner */}
        {email.usdc_amount && (
          <div className="bg-green-900/20 border border-green-700/50 rounded-lg p-4 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">$</span>
              <div>
                <div className="text-green-400 font-bold text-lg">{email.usdc_amount} USDC</div>
                <div className="text-green-600 text-xs">Verified Payment (Base Sepolia Testnet)</div>
              </div>
            </div>
            {email.usdc_tx && (
              <a
                href={`https://sepolia.basescan.org/tx/${email.usdc_tx}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-500 hover:text-green-400 text-xs underline"
              >
                View on BaseScan
              </a>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400 mb-6 pb-4 border-b border-gray-800">
          <div>
            <span className="text-gray-500">From:</span>{' '}
            <span className="text-white font-mono text-xs">{email.from_addr}</span>
          </div>
          <div>
            <span className="text-gray-500">To:</span>{' '}
            <span className="text-white font-mono text-xs">{email.to_addr}</span>
          </div>
          <div className="ml-auto text-gray-600">
            {new Date(email.created_at * 1000).toLocaleString()}
          </div>
        </div>
        <div className="whitespace-pre-wrap text-gray-300 font-mono text-sm leading-relaxed">
          {bodyText}
        </div>
      </div>
    </div>
  );
}

// ─── Buy Credits Modal ──────────────────────────────────
function BuyCreditsModal({
  auth,
  onClose,
  onSuccess,
}: {
  auth: AuthState;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const walletAddr = auth.wallet as `0x${string}`;
  const { data: baseEthBal } = useBalance({ address: walletAddr, chainId: base.id });
  const { data: mainnetEthBal } = useBalance({ address: walletAddr, chainId: mainnet.id });
  const [credits, setCredits] = useState<number>(0);
  const [amount, setAmount] = useState('0.001');
  const [txHash, setTxHash] = useState('');
  const [payChainId, setPayChainId] = useState<number>(0);
  const [status, setStatus] = useState<'idle' | 'paying' | 'confirming' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);
  const [tab, setTab] = useState<'wallet' | 'api'>('wallet');

  // Fetch current credits
  useEffect(() => {
    apiFetch('/api/credits', auth.token)
      .then((r) => r.json())
      .then((data) => setCredits(data.credits || 0));
  }, [auth.token]);

  const creditsForAmount = Math.floor(parseFloat(amount || '0') * 1_000_000);

  async function handleWalletPay() {
    setStatus('paying');
    setError('');
    try {
      const payAmount = parseEther(amount);

      // Smart chain selection: prefer Base, fallback to ETH mainnet
      let targetChainId = base.id;
      if (baseEthBal && baseEthBal.value < payAmount && mainnetEthBal && mainnetEthBal.value >= payAmount) {
        targetChainId = mainnet.id;
      }

      // Switch to correct chain
      await switchChainAsync({ chainId: targetChainId });

      const hash = await sendTransactionAsync({
        to: DEPOSIT_ADDRESS as `0x${string}`,
        value: payAmount,
        chainId: targetChainId,
      });
      setTxHash(hash);
      setPayChainId(targetChainId);
      setStatus('confirming');

      // Backend will wait up to 60s for on-chain confirmation
      const res = await apiFetch('/api/credits/buy', auth.token, {
        method: 'POST',
        body: JSON.stringify({ tx_hash: hash, chain_id: targetChainId }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Might need more time, let user retry
        setError(data.error || 'Confirming... try Check Balance in a few seconds');
        setStatus('idle');
        return;
      }
      setCredits(data.balance);
      setStatus('success');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    } catch (e: any) {
      setError(e.message || 'Payment failed');
      setStatus('idle');
    }
  }

  async function handleManualCheck() {
    if (!txHash) {
      // Just refresh credits
      const res = await apiFetch('/api/credits', auth.token);
      const data = await res.json();
      const newCredits = data.credits || 0;
      if (newCredits > credits) {
        setCredits(newCredits);
        setStatus('success');
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 4000);
      } else {
        setCredits(newCredits);
      }
      return;
    }

    setStatus('confirming');
    setError('');
    try {
      const res = await apiFetch('/api/credits/buy', auth.token, {
        method: 'POST',
        body: JSON.stringify({ tx_hash: txHash, chain_id: payChainId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCredits(data.balance);
      setStatus('success');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    } catch (e: any) {
      setError(e.message);
      setStatus('idle');
    }
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=1a1a2e&color=ffffff&data=ethereum:${DEPOSIT_ADDRESS}@8453`;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      {/* Confetti */}
      {showConfetti && <ConfettiEffect />}

      <div className="bg-base-gray rounded-xl p-6 max-w-md w-full border border-gray-800 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">Buy Email Credits</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">&times;</button>
        </div>

        {/* Current balance */}
        <div className="bg-base-dark rounded-lg p-3 mb-4 flex items-center justify-between">
          <span className="text-gray-400 text-sm">Current Balance</span>
          <span className="text-2xl font-bold text-base-blue">{credits}</span>
        </div>

        {status === 'success' ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">&#127881;</div>
            <h4 className="text-xl font-bold text-green-400 mb-2">Credits Added!</h4>
            <p className="text-gray-400 mb-4">You now have <span className="text-base-blue font-bold">{credits}</span> credits</p>
            <button
              onClick={onSuccess}
              className="bg-base-blue text-white px-8 py-3 rounded-lg font-medium hover:bg-blue-600 transition"
            >
              OK, Send Email
            </button>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex gap-1 bg-base-dark rounded-lg p-1 mb-4">
              <button
                onClick={() => setTab('wallet')}
                className={`flex-1 py-2 rounded-md text-sm transition ${tab === 'wallet' ? 'bg-base-blue text-white' : 'text-gray-400 hover:text-white'}`}
              >
                Pay with Wallet
              </button>
              <button
                onClick={() => setTab('api')}
                className={`flex-1 py-2 rounded-md text-sm transition ${tab === 'api' ? 'bg-base-blue text-white' : 'text-gray-400 hover:text-white'}`}
              >
                API / Agent
              </button>
            </div>

            {tab === 'wallet' ? (
              <>
                {/* Pricing info */}
                <div className="text-sm text-gray-400 mb-4 space-y-1">
                  <p>1 credit = 1 external email ($0.002)</p>
                  <p>0.001 ETH = 1,000 credits (min: 0.0001 ETH)</p>
                </div>

                {/* Amount input */}
                <div className="mb-4">
                  <label className="text-gray-400 text-xs mb-1 block">
                  Amount (ETH) — pays on {baseEthBal && baseEthBal.value >= parseEther(amount || '0') ? 'Base' : mainnetEthBal && mainnetEthBal.value >= parseEther(amount || '0') ? 'ETH Mainnet' : 'Base'}
                </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      className="flex-1 bg-base-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-base-blue"
                    />
                    <span className="bg-base-dark border border-gray-700 rounded-lg px-3 py-2 text-gray-400 text-sm">
                      = {creditsForAmount.toLocaleString()} credits
                    </span>
                  </div>
                </div>

                {/* QR Code */}
                <div className="text-center mb-4">
                  <img
                    src={qrUrl}
                    alt="Payment QR Code"
                    className="mx-auto rounded-lg mb-2"
                    width={160}
                    height={160}
                  />
                  <div className="font-mono text-xs text-gray-400 break-all px-4">{DEPOSIT_ADDRESS}</div>
                  <CopyButton text={DEPOSIT_ADDRESS} label="Copy address" />
                </div>

                {/* Pay button */}
                {status === 'confirming' ? (
                  <div className="mb-2 bg-base-dark rounded-lg p-3 border border-gray-700">
                    <ChainSearchSpinner maxSeconds={60} />
                  </div>
                ) : (
                  <button
                    onClick={handleWalletPay}
                    disabled={status === 'paying' || !amount || parseFloat(amount) < 0.0001}
                    className="w-full bg-base-blue text-white py-3 rounded-lg font-medium hover:bg-blue-600 transition disabled:opacity-50 mb-2"
                  >
                    {status === 'paying' ? 'Confirm in wallet...' : `Pay ${amount} ETH`}
                  </button>
                )}

                {/* Manual tx hash */}
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <label className="text-gray-500 text-xs mb-1 block">Already paid? Paste tx hash:</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={txHash}
                      onChange={(e) => setTxHash(e.target.value)}
                      placeholder="0x..."
                      className="flex-1 bg-base-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-base-blue"
                    />
                    <button
                      onClick={handleManualCheck}
                      disabled={status === 'confirming'}
                      className="bg-gray-700 text-white px-3 py-2 rounded-lg text-xs hover:bg-gray-600 transition disabled:opacity-50 whitespace-nowrap"
                    >
                      Check
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* API / Agent tab */
              <div className="text-sm space-y-3">
                <p className="text-gray-400">
                  For AI Agents: send ETH on Base chain to the deposit address, then submit the tx hash via API.
                </p>
                <div className="bg-base-dark rounded-lg p-3 font-mono text-xs text-gray-300 space-y-2">
                  <div className="text-gray-500"># 1. Send ETH on Base to:</div>
                  <div className="text-base-blue break-all">{DEPOSIT_ADDRESS}</div>
                  <div className="text-gray-500 mt-2"># 2. Submit tx hash:</div>
                  <div className="text-green-400">
                    {`POST /api/credits/buy`}
                  </div>
                  <div className="text-gray-400">
                    {`{ "tx_hash": "0x..." }`}
                  </div>
                  <div className="text-gray-500 mt-2"># Pricing:</div>
                  <div className="text-gray-400">
                    1 ETH = 1,000,000 credits<br />
                    Min: 0.0001 ETH = 100 credits<br />
                    1 credit = 1 external email
                  </div>
                </div>
                <CopyButton text={DEPOSIT_ADDRESS} label="Copy deposit address" />
              </div>
            )}

            {error && <div className="text-red-400 text-sm mt-3">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Compose ────────────────────────────────────────────
function Compose({ auth }: { auth: AuthState }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);

  const [to, setTo] = useState(params.get('to') || '');
  const [subject, setSubject] = useState(params.get('subject') || '');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showBuyCredits, setShowBuyCredits] = useState(false);

  async function handleSend() {
    if (!to || !subject || !body) {
      setError('All fields are required');
      return;
    }

    setSending(true);
    setError('');
    try {
      const res = await apiFetch('/api/send', auth.token, {
        method: 'POST',
        body: JSON.stringify({ to, subject, body }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Check if it's a credits error
        if (res.status === 402 || data.error?.includes('credit') || data.error?.includes('Credit')) {
          setShowBuyCredits(true);
          setError('');
          return;
        }
        throw new Error(data.error || 'Failed to send');
      }
      navigate('/dashboard/sent');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Compose</h2>
      <div className="max-w-2xl space-y-4">
        <div>
          <label className="text-gray-400 text-sm mb-1 block">From</label>
          <div className="bg-base-gray rounded-lg px-4 py-3 font-mono text-base-blue border border-gray-800 text-sm truncate" title={`${auth.handle}@basemail.ai`}>
            {truncateEmail(auth.handle!)}
          </div>
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">To</label>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="w-full bg-base-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-base-blue"
          />
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject"
            className="w-full bg-base-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-base-blue"
          />
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message..."
            rows={10}
            className="w-full bg-base-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-base-blue resize-y"
          />
        </div>

        {error && <div className="text-red-400 text-sm">{error}</div>}

        <button
          onClick={handleSend}
          disabled={sending}
          className="bg-base-blue text-white px-8 py-3 rounded-lg font-medium hover:bg-blue-600 transition disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>

      {showBuyCredits && (
        <BuyCreditsModal
          auth={auth}
          onClose={() => setShowBuyCredits(false)}
          onSuccess={() => {
            setShowBuyCredits(false);
            // Auto-retry send
            handleSend();
          }}
        />
      )}
    </div>
  );
}

// ─── Credits ────────────────────────────────────────────
function Credits({ auth }: { auth: AuthState }) {
  const [credits, setCredits] = useState<number | null>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [recoverHash, setRecoverHash] = useState('');
  const [recoverStatus, setRecoverStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [recoverMsg, setRecoverMsg] = useState('');

  function loadData() {
    Promise.all([
      apiFetch('/api/credits', auth.token).then((r) => r.json()),
      apiFetch('/api/credits/history', auth.token).then((r) => r.json()),
    ])
      .then(([creditData, historyData]) => {
        setCredits(creditData.credits ?? 0);
        setPricing(creditData.pricing);
        setHistory(historyData.transactions || []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, [auth.token]);

  if (loading) return <div className="text-gray-500 text-center py-20">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Credits</h2>
      <div className="max-w-2xl space-y-6">
        <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
          <div className="text-gray-400 text-sm mb-1">Balance</div>
          <div className="text-4xl font-bold text-base-blue">{credits}</div>
          <div className="text-gray-500 text-sm mt-1">
            1 credit = 1 external email
          </div>
          <button
            onClick={() => setShowBuyCredits(true)}
            className="mt-4 bg-base-blue text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-600 transition text-sm"
          >
            Buy Credits
          </button>
        </div>

        {pricing && (
          <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
            <h3 className="font-bold mb-4">Pricing</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Rate</span>
                <span className="font-mono">{pricing.example}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Min purchase</span>
                <span className="font-mono">{pricing.min_purchase}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Cost per email</span>
                <span className="font-mono">{pricing.cost_per_email_usd}</span>
              </div>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
            <h3 className="font-bold mb-4">Transaction History</h3>
            <div className="space-y-2 text-sm">
              {history.map((tx: any) => (
                <div key={tx.id} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div>
                    <span className={`font-mono ${tx.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {tx.amount > 0 ? '+' : ''}{tx.amount}
                    </span>
                    <span className="text-gray-500 ml-2">{tx.type}</span>
                  </div>
                  <span className="text-gray-600 text-xs">
                    {new Date(tx.created_at * 1000).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recover lost credits */}
        <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-1">Lost your credits?</h3>
          <p className="text-gray-500 text-xs mb-4">
            Paid but credits didn't show up? Paste your transaction hash below. We'll check both Base and ETH Mainnet automatically.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={recoverHash}
              onChange={(e) => { setRecoverHash(e.target.value.trim()); setRecoverStatus('idle'); setRecoverMsg(''); }}
              placeholder="0x..."
              className="flex-1 bg-base-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-base-blue"
            />
            <button
              onClick={async () => {
                if (!recoverHash || !recoverHash.startsWith('0x')) {
                  setRecoverMsg('Please enter a valid transaction hash');
                  setRecoverStatus('error');
                  return;
                }
                setRecoverStatus('checking');
                setRecoverMsg('Checking Base and ETH Mainnet...');
                try {
                  const res = await apiFetch('/api/credits/buy', auth.token, {
                    method: 'POST',
                    body: JSON.stringify({ tx_hash: recoverHash }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error);
                  setRecoverStatus('success');
                  setRecoverMsg(`Recovered ${data.purchased} credits from ${data.chain || 'on-chain'} payment (${data.eth_spent} ETH)`);
                  setCredits(data.balance);
                  loadData();
                } catch (e: any) {
                  setRecoverStatus('error');
                  setRecoverMsg(e.message || 'Recovery failed');
                }
              }}
              disabled={recoverStatus === 'checking'}
              className="bg-gray-700 text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-gray-600 transition disabled:opacity-50 whitespace-nowrap"
            >
              {recoverStatus === 'checking' ? 'Checking...' : 'Recover'}
            </button>
          </div>
          {recoverStatus === 'checking' && <ChainSearchSpinner maxSeconds={30} />}
          {recoverMsg && recoverStatus !== 'checking' && (
            <p className={`text-xs mt-2 ${recoverStatus === 'success' ? 'text-green-400' : recoverStatus === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
              {recoverMsg}
            </p>
          )}
        </div>
      </div>

      {showBuyCredits && (
        <BuyCreditsModal
          auth={auth}
          onClose={() => { setShowBuyCredits(false); loadData(); }}
          onSuccess={() => { setShowBuyCredits(false); loadData(); }}
        />
      )}
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────
function Settings({ auth, setAuth, onUpgrade, upgrading }: { auth: AuthState; setAuth: (a: AuthState) => void; onUpgrade?: (basename?: string) => void; upgrading?: boolean }) {
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const [webhook, setWebhook] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsBasenameInput, setSettingsBasenameInput] = useState('');
  const [settingsUpgradeError, setSettingsUpgradeError] = useState('');
  const [proStatus, setProStatus] = useState<'idle' | 'paying' | 'confirming' | 'success' | 'error'>('idle');
  const [proError, setProError] = useState('');
  const [showProConfetti, setShowProConfetti] = useState(false);

  const fullEmail = `${auth.handle}@basemail.ai`;
  const hasBasename = !!auth.basename && !/^0x/i.test(auth.handle!);
  const altEmail = hasBasename ? `${auth.wallet.toLowerCase()}@basemail.ai` : null;
  const canUpgradeKnown = auth.upgrade_available && auth.suggested_handle && /^0x/i.test(auth.handle!);
  const canUpgradeNFT = auth.has_basename_nft && /^0x/i.test(auth.handle!) && !auth.suggested_handle;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>
      <div className="max-w-2xl space-y-6">
        <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">Account</h3>
          <div className="space-y-3 text-sm">
            {/* Already upgraded — show Basename info first */}
            {hasBasename && auth.basename && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Basename</span>
                  <span className="font-mono text-base-blue text-xs font-bold">{auth.basename}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Basename Email</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base-blue text-xs break-all">{fullEmail}</span>
                    <CopyButton text={fullEmail} />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">0x Email</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-gray-300 text-xs break-all">{altEmail}</span>
                    <CopyButton text={altEmail!} />
                  </div>
                </div>
              </>
            )}
            {/* No basename upgrade yet — show current 0x email */}
            {!hasBasename && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Email</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base-blue text-xs break-all">{fullEmail}</span>
                  <CopyButton text={fullEmail} />
                </div>
              </div>
            )}
            {/* Basename detected (name known) — upgrade prompt */}
            {canUpgradeKnown && auth.basename && (
              <div className="bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-700/50 rounded-lg p-4 mt-2">
                <div className="flex items-center gap-2 mb-2">
                  <span>&#10024;</span>
                  <span className="text-blue-300 text-xs font-bold">Basename Detected: {auth.basename}</span>
                </div>
                <p className="text-gray-400 text-xs mb-3">
                  Upgrade your email to <span className="text-base-blue font-bold">{auth.suggested_handle}@basemail.ai</span>
                </p>
                {onUpgrade && (
                  <button
                    onClick={() => onUpgrade()}
                    disabled={upgrading}
                    className="bg-base-blue text-white px-5 py-2 rounded-lg text-sm hover:bg-blue-500 transition disabled:opacity-50"
                  >
                    {upgrading ? 'Upgrading...' : '\u2728 Claim Basename Email'}
                  </button>
                )}
              </div>
            )}
            {/* Basename NFT detected but name unknown — manual input */}
            {canUpgradeNFT && (
              <div className="bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-700/50 rounded-lg p-4 mt-2">
                <div className="flex items-center gap-2 mb-2">
                  <span>&#10024;</span>
                  <span className="text-blue-300 text-xs font-bold">Basename NFT Detected!</span>
                </div>
                <p className="text-gray-400 text-xs mb-3">
                  Enter your Basename to upgrade your email address.
                </p>
                <div className="flex gap-2 mb-2">
                  <div className="flex-1 flex items-center bg-base-dark rounded-lg border border-gray-700 px-2">
                    <input
                      type="text"
                      value={settingsBasenameInput}
                      onChange={(e) => { setSettingsBasenameInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setSettingsUpgradeError(''); }}
                      placeholder="yourname"
                      className="flex-1 bg-transparent py-2 text-white font-mono text-sm focus:outline-none"
                    />
                    <span className="text-gray-500 font-mono text-xs">.base.eth</span>
                  </div>
                  {onUpgrade && (
                    <button
                      onClick={() => {
                        if (!settingsBasenameInput.trim()) { setSettingsUpgradeError('Please enter your Basename'); return; }
                        onUpgrade(`${settingsBasenameInput.trim()}.base.eth`);
                      }}
                      disabled={upgrading || !settingsBasenameInput.trim()}
                      className="bg-base-blue text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-500 transition disabled:opacity-50"
                    >
                      {upgrading ? 'Verifying...' : '\u2728 Claim'}
                    </button>
                  )}
                </div>
                {settingsUpgradeError && <p className="text-red-400 text-xs">{settingsUpgradeError}</p>}
              </div>
            )}
            {/* No basename at all */}
            {!auth.basename && !auth.has_basename_nft && (
              <div className="bg-gray-800/50 rounded-lg p-3 mt-2 text-xs text-gray-400">
                No Basename detected.{' '}
                <a href="https://www.base.org/names" target="_blank" rel="noopener noreferrer" className="text-base-blue hover:underline">
                  Get a Basename
                </a>{' '}
                for a human-readable email address.
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-gray-800">
              <span className="text-gray-400">Wallet</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-gray-300 text-xs">{auth.wallet}</span>
                <CopyButton text={auth.wallet} />
              </div>
            </div>
          </div>
        </div>

        {/* BaseMail Pro */}
        <div className={`rounded-xl p-6 border ${auth.tier === 'pro' ? 'bg-gradient-to-r from-yellow-900/20 to-amber-900/20 border-yellow-700/50' : 'bg-base-gray border-gray-800'}`}>
          {showProConfetti && <ConfettiEffect />}
          <h3 className="font-bold mb-4 flex items-center gap-2">
            {auth.tier === 'pro' ? (
              <><span style={{ color: '#FFD700' }}>&#10003;</span> BaseMail Pro</>
            ) : (
              'BaseMail Pro'
            )}
          </h3>
          {auth.tier === 'pro' ? (
            <div className="space-y-2 text-sm">
              <p className="text-green-400">You are a Pro member!</p>
              <ul className="text-gray-400 space-y-1">
                <li>&#10003; No email signature on outgoing emails</li>
                <li>&#10003; Gold badge</li>
                <li>&#10003; Priority support</li>
              </ul>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-gray-400 text-sm">
                Remove the BaseMail signature from your emails and get a gold badge. One-time lifetime purchase.
              </p>
              <div className="bg-base-dark rounded-lg p-4 border border-gray-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-gray-400 text-sm">Price</span>
                  <span className="text-xl font-bold text-base-blue">0.008 ETH</span>
                </div>
                <ul className="text-gray-500 text-xs space-y-1 mb-4">
                  <li>&#10003; Remove email signature forever</li>
                  <li>&#10003; Gold badge on your profile</li>
                  <li>&#10003; Priority support</li>
                </ul>
                <button
                  onClick={async () => {
                    setProStatus('paying');
                    setProError('');
                    try {
                      await switchChainAsync({ chainId: base.id });
                      const hash = await sendTransactionAsync({
                        to: DEPOSIT_ADDRESS as `0x${string}`,
                        value: parseEther('0.008'),
                        chainId: base.id,
                      });
                      setProStatus('confirming');
                      const res = await apiFetch('/api/pro/buy', auth.token, {
                        method: 'POST',
                        body: JSON.stringify({ tx_hash: hash, chain_id: base.id }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error);
                      setProStatus('success');
                      setShowProConfetti(true);
                      setTimeout(() => setShowProConfetti(false), 4000);
                      setAuth({ ...auth, tier: 'pro' });
                    } catch (e: any) {
                      setProError(e.message || 'Purchase failed');
                      setProStatus('idle');
                    }
                  }}
                  disabled={proStatus === 'paying' || proStatus === 'confirming'}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-medium hover:from-blue-500 hover:to-indigo-500 transition disabled:opacity-50"
                >
                  {proStatus === 'paying' ? 'Confirm in wallet...' : proStatus === 'confirming' ? 'Verifying on-chain...' : 'Upgrade to Pro'}
                </button>
              </div>
              {proError && <p className="text-red-400 text-sm">{proError}</p>}
            </div>
          )}
        </div>

        <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">Webhook Notification</h3>
          <p className="text-gray-400 text-sm mb-4">
            Get notified when new emails arrive. Set a webhook URL that BaseMail will POST to.
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              value={webhook}
              onChange={(e) => { setWebhook(e.target.value); setSaved(false); }}
              placeholder="https://your-agent.example.com/webhook"
              className="flex-1 bg-base-dark border border-gray-700 rounded-lg px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-base-blue"
            />
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await apiFetch('/api/register', auth.token, {
                    method: 'PUT',
                    body: JSON.stringify({ webhook_url: webhook }),
                  });
                  setSaved(true);
                } catch {}
                setSaving(false);
              }}
              disabled={saving}
              className="bg-base-blue text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        <div className="bg-base-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">API Token</h3>
          <p className="text-gray-400 text-sm mb-4">
            Use this token in your AI Agent's API calls. It expires in 24 hours — reconnect your wallet to get a fresh one.
          </p>
          <div className="bg-base-dark rounded-lg px-4 py-3 font-mono text-sm text-gray-300 break-all select-all cursor-pointer"
               onClick={() => navigator.clipboard.writeText(auth.token)}
               title="Click to copy">
            {auth.token}
          </div>
          <p className="text-gray-600 text-xs mt-2">Click to copy</p>
        </div>
      </div>
    </div>
  );
}
