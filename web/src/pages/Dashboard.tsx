import { useState, useEffect, useCallback, Fragment } from 'react';
import { Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAccount, useConnect, useDisconnect, useSignMessage, useSendTransaction, useBalance, useSwitchChain } from 'wagmi';
import { parseEther, formatUnits, encodeFunctionData, createPublicClient, http } from 'viem';

const API_BASE = import.meta.env.PROD ? 'https://api.nadmail.ai' : '';
const DEPOSIT_ADDRESS = '0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe';
const MONAD_CHAIN_ID = 143;

interface EmailItem {
  id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  read: number;
  created_at: number;
  microbuy_tx?: string | null;
}

interface AuthState {
  token: string;
  wallet: string;
  handle: string | null;
  registered: boolean;
  tier?: 'free' | 'pro';
  token_address?: string | null;
  token_symbol?: string | null;
  pending_emails?: number;
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
          <circle cx="16" cy="16" r="13" fill="none" stroke="#7B3FE4" strokeWidth="3"
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
          {elapsed < 5 ? 'Checking Monad...' : 'Waiting for confirmation...'}
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
  if (handle.length <= 20) return `${handle}@nadmail.ai`;
  return `${handle.slice(0, 6)}...${handle.slice(-4)}@nadmail.ai`;
}

const MONAD_EXPLORER = 'https://explorer.monad.xyz';

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
      className="text-gray-500 hover:text-nad-purple transition text-xs flex items-center gap-1"
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

// ─── Upgrade Banner (0x → .nad) ─────────────────────────

interface NadNameInfo {
  name: string;
  available: boolean;
}

function UpgradeBanner({
  auth,
  setAuth,
  claimName,
}: {
  auth: AuthState;
  setAuth: (a: AuthState) => void;
  claimName?: string | null;
}) {
  const [nadNames, setNadNames] = useState<NadNameInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(() =>
    claimName ? false : sessionStorage.getItem('nadmail_upgrade_dismissed') === 'true'
  );
  const [success, setSuccess] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);

  useEffect(() => {
    if (!auth.handle?.startsWith('0x') || dismissed) {
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/api/register/nad-names/${auth.wallet}`)
      .then((r) => r.json())
      .then((data) => {
        const available = (data.names || []).filter((n: NadNameInfo) => n.available);
        setNadNames(available);
        // Auto-select from ?claim= param or single available name
        if (claimName) {
          const match = available.find((n: NadNameInfo) => n.name === claimName);
          if (match) setSelectedName(match.name);
          else if (available.length === 1) setSelectedName(available[0].name);
        } else if (available.length === 1) {
          setSelectedName(available[0].name);
        }
      })
      .catch(() => setNadNames([]))
      .finally(() => setLoading(false));
  }, [auth.wallet, auth.handle, dismissed, claimName]);

  if (loading || dismissed || !auth.handle?.startsWith('0x') || nadNames.length === 0) {
    return null;
  }

  async function handleUpgrade() {
    if (!selectedName) return;
    setUpgrading(true);
    setError('');
    try {
      const res = await apiFetch('/api/register/upgrade-handle', auth.token, {
        method: 'POST',
        body: JSON.stringify({ new_handle: selectedName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upgrade failed');

      setSuccess(true);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);

      // Update auth state with new handle + token
      setAuth({
        ...auth,
        handle: data.new_handle,
        token: data.token,
        token_address: data.token_address || auth.token_address,
        token_symbol: data.token_symbol || auth.token_symbol,
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUpgrading(false);
    }
  }

  function handleDismiss() {
    setDismissed(true);
    sessionStorage.setItem('nadmail_upgrade_dismissed', 'true');
  }

  if (success) {
    return (
      <>
        {showConfetti && <ConfettiEffect />}
        <div className="bg-green-900/20 border border-green-700/50 rounded-xl p-6 mb-6 text-center">
          <div className="text-3xl mb-2">&#127881;</div>
          <h3 className="text-xl font-bold text-green-400 mb-1">Upgraded!</h3>
          <p className="text-gray-300">
            Your email is now <span className="text-nad-purple font-mono font-bold">{selectedName}@nadmail.ai</span>
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="bg-purple-900/20 border border-purple-700/50 rounded-xl p-6 mb-6">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-lg mb-1">
            Upgrade your email!
          </h3>
          <p className="text-gray-400 text-sm">
            You own {nadNames.length === 1 ? 'a' : nadNames.length} .nad name{nadNames.length > 1 ? 's' : ''}! Upgrade from your 0x address to a memorable email + get a meme coin.
          </p>
        </div>
        <button onClick={handleDismiss} className="text-gray-500 hover:text-gray-300 text-xl ml-4" title="Dismiss">&times;</button>
      </div>

      <div className="bg-nad-dark/50 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-3 text-sm mb-2">
          <span className="text-gray-500">Now:</span>
          <span className="text-gray-400 font-mono">{truncateEmail(auth.handle!)}</span>
          <span className="text-gray-600 text-xs">(no token)</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">After:</span>
          <span className="text-nad-purple font-mono font-bold">
            {selectedName ? `${selectedName}@nadmail.ai` : '—'}
          </span>
          {selectedName && (
            <span className="text-purple-400 text-xs font-mono">${selectedName.toUpperCase()} token</span>
          )}
        </div>
      </div>

      {nadNames.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {nadNames.map((n) => (
            <button
              key={n.name}
              onClick={() => setSelectedName(n.name)}
              className={`px-3 py-1.5 rounded-lg text-sm font-mono transition border ${
                selectedName === n.name
                  ? 'border-nad-purple bg-purple-900/30 text-nad-purple'
                  : 'border-gray-700 bg-nad-dark text-gray-300 hover:border-purple-600'
              }`}
            >
              {n.name}.nad
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={handleUpgrade}
          disabled={upgrading || !selectedName}
          className="bg-nad-purple text-white px-6 py-2 rounded-lg font-medium hover:bg-purple-600 transition disabled:opacity-50"
        >
          {upgrading ? 'Upgrading...' : 'Upgrade Now'}
        </button>
        <button
          onClick={handleDismiss}
          className="text-gray-500 hover:text-gray-300 text-sm transition"
        >
          Maybe Later
        </button>
      </div>
    </div>
  );
}

// ─── Proxy Buy Banner ──────────────────────────────────────

const NNS_REGISTRAR_ADDR = '0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb';
const DIPLOMAT_ADDR = '0x7e0F24854c7189C9B709132fEb6e953D4EC74424';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

function caesarShift(text: string, shift: number): string {
  const n = ((shift % 26) + 26) % 26;
  return text.split('').map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode((code - 65 + n) % 26 + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode((code - 97 + n) % 26 + 97);
    return c;
  }).join('');
}

function encodeNnsData(data: object): string {
  const json = JSON.stringify(data);
  const b64 = btoa(json);
  return caesarShift(b64, -19);
}

function decodeNnsData(encoded: string): any {
  const b64 = caesarShift(encoded, 19);
  return JSON.parse(atob(b64));
}

const registerWithSignatureAbi = [{
  inputs: [
    { name: 'params', type: 'tuple', components: [
      { name: 'name', type: 'string' },
      { name: 'nameOwner', type: 'address' },
      { name: 'setAsPrimaryName', type: 'bool' },
      { name: 'referrer', type: 'address' },
      { name: 'discountKey', type: 'bytes32' },
      { name: 'discountClaimProof', type: 'bytes' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'attributes', type: 'tuple[]', components: [
        { name: 'key', type: 'string' },
        { name: 'value', type: 'string' },
      ]},
      { name: 'paymentToken', type: 'address' },
    ]},
    { name: 'signature', type: 'bytes' },
  ],
  name: 'registerWithSignature',
  outputs: [],
  stateMutability: 'payable',
  type: 'function',
}] as const;

function ProxyBuyBanner({
  auth,
  setAuth,
  name,
}: {
  auth: AuthState;
  setAuth: (a: AuthState) => void;
  name: string;
}) {
  const [priceInfo, setPriceInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [success, setSuccess] = useState(false);
  const { sendTransactionAsync } = useSendTransaction();
  const { address } = useAccount();

  useEffect(() => {
    fetch(`${API_BASE}/api/register/nad-name-price/${encodeURIComponent(name)}?buyer=${auth.wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.available_nns && data.available_nadmail) {
          setPriceInfo(data);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [name, auth.wallet]);

  if (loading || dismissed || !priceInfo) return null;
  if (auth.handle === name && !success) return null;

  if (success) {
    return (
      <div className="mb-6 bg-gradient-to-r from-green-900/30 to-purple-900/20 border border-green-700 rounded-xl p-4 text-center">
        <p className="text-2xl mb-2">🎉</p>
        <p className="text-green-400 font-bold text-lg">{name}.nad registered!</p>
        <p className="text-gray-300 text-sm">{status || `${name}@nadmail.ai is being set up...`}</p>
        {auth.handle !== name && (
          <button
            className="mt-3 bg-nad-purple text-white py-2 px-6 rounded-lg font-medium hover:bg-purple-600 transition text-sm"
            onClick={() => window.location.reload()}
          >
            🔄 Refresh to activate
          </button>
        )}
      </div>
    );
  }

  async function handleBuy() {
    if (!address) { setError('Please connect your wallet'); return; }
    setBuying(true);
    setError('');

    try {
      // 1. Get signature + discount via our proxy API (avoids CORS issues with api.nad.domains)
      setStatus('Preparing registration...');
      const signRes = await fetch(`${API_BASE}/api/register/nad-name-sign/${encodeURIComponent(name)}?buyer=${address}`);
      const signData = await signRes.json();
      if (!signRes.ok || !signData.signature) {
        throw new Error(signData.error || 'Failed to prepare registration');
      }

      // 2. Calculate price
      const priceWei = BigInt(priceInfo.discounted_price_wei || priceInfo.price_wei);

      // 3. Send transaction via MetaMask
      setStatus('Confirm in your wallet...');
      const calldata = encodeFunctionData({
        abi: registerWithSignatureAbi,
        functionName: 'registerWithSignature',
        args: [{
          name,
          nameOwner: address,
          setAsPrimaryName: true,
          referrer: signData.referrer as `0x${string}`,
          discountKey: signData.discountKey as `0x${string}`,
          discountClaimProof: signData.discountClaimProof as `0x${string}`,
          nonce: BigInt(signData.nonce),
          deadline: BigInt(signData.deadline),
          attributes: [],
          paymentToken: ZERO_ADDR as `0x${string}`,
        }, signData.signature as `0x${string}`],
      });

      const txHash = await sendTransactionAsync({
        to: NNS_REGISTRAR_ADDR as `0x${string}`,
        data: calldata,
        value: priceWei,
        chainId: 143,
      });

      // 5. Wait for transaction confirmation
      setStatus('Waiting for confirmation...');
      const monadClient = createPublicClient({
        chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } },
        transport: http('https://rpc.monad.xyz'),
      });

      const receipt = await monadClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== 'success') {
        throw new Error('Transaction failed on-chain');
      }

      // 6. Upgrade handle on NadMail
      setStatus('Setting up your email...');
      let upgraded = false;
      // Retry a few times (chain state might need a moment to propagate)
      for (let i = 0; i < 3; i++) {
        try {
          const r = await apiFetch('/api/register/upgrade-handle', auth.token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_handle: name }),
          });
          const data = await r.json();
          if (data.token) {
            const newAuth = { ...auth, handle: name, token: data.token };
            setAuth(newAuth);
            localStorage.setItem('nadmail_auth', JSON.stringify(newAuth));
            upgraded = true;
            break;
          }
          if (r.ok) { upgraded = true; break; }
        } catch {}
        // Wait 2s before retry
        if (i < 2) await new Promise(r => setTimeout(r, 2000));
      }

      setSuccess(true);
      setStatus(upgraded
        ? `✅ ${name}@nadmail.ai is ready!`
        : `✅ ${name}.nad registered! Refresh to claim your email.`
      );
      setError('');
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Transaction failed';
      if (msg.includes('User rejected') || msg.includes('denied')) {
        setError('Transaction cancelled');
      } else {
        setError(msg);
      }
      setStatus('');
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="mb-6 bg-gradient-to-r from-purple-900/30 to-yellow-900/20 border border-purple-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-bold text-white">🛒 Get {name}.nad</h3>
        <button className="text-gray-400 hover:text-white text-sm" onClick={() => setDismissed(true)}>✕</button>
      </div>
      <p className="text-gray-300 text-sm mb-3">
        Upgrade to <span className="text-nad-purple font-bold">{name}@nadmail.ai</span> and auto-create <span className="text-nad-purple font-mono">${name.toUpperCase()}</span> token
      </p>
      {priceInfo.discount && (
        <div className="text-xs text-gray-400 mb-2 space-y-1">
          <div className="flex justify-between">
            <span>Registration fee</span>
            <span className="line-through text-gray-600">{priceInfo.price_mon.toFixed(2)} MON</span>
          </div>
          <div className="flex justify-between">
            <span className="text-green-400">Discount: {priceInfo.discount.description}</span>
            <span className="text-green-400">-{priceInfo.discount.percent}%</span>
          </div>
          <div className="flex justify-between border-t border-gray-700 pt-1">
            <span className="font-bold text-white">Total</span>
            <span className="text-yellow-300 font-mono font-bold">{priceInfo.discounted_price_mon.toFixed(2)} MON</span>
          </div>
        </div>
      )}
      {!priceInfo.discount && (
        <div className="text-xs text-gray-400 mb-2">
          <div className="flex justify-between">
            <span className="font-bold text-white">Price</span>
            <span className="text-yellow-300 font-mono font-bold">{priceInfo.price_mon.toFixed(2)} MON</span>
          </div>
        </div>
      )}
      {status && <p className="text-yellow-300 text-xs mb-2 animate-pulse">⏳ {status}</p>}
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          disabled={buying}
          className="flex-1 bg-nad-purple text-white py-2 px-4 rounded-lg font-medium hover:bg-purple-600 transition text-sm disabled:opacity-50"
          onClick={handleBuy}
        >
          {buying ? '⏳ Processing...' : `🛒 Register ${name}.nad — ${priceInfo.discounted_price_mon?.toFixed(2) || priceInfo.price_mon.toFixed(2)} MON`}
        </button>
        {priceInfo.referral?.url && (
          <a
            href={priceInfo.referral.url}
            target="_blank"
            rel="noopener noreferrer"
            className="border border-gray-600 text-gray-300 py-2 px-4 rounded-lg hover:bg-gray-800 transition text-sm text-center"
          >↗</a>
        )}
      </div>
    </div>
  );
}

// ─── Token Balance (ERC20) ────────────────────────────────
const ERC20_BALANCE_ABI = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

function TokenBalance({ address, wallet }: { address: string; wallet: string }) {
  const [balance, setBalance] = useState<string>('—');

  useEffect(() => {
    const client = createPublicClient({
      chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } },
      transport: http('https://rpc.monad.xyz'),
    });

    client.readContract({
      address: address as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [wallet as `0x${string}`],
    }).then((bal) => {
      const formatted = parseFloat(formatUnits(bal as bigint, 18));
      if (formatted >= 1_000_000) {
        setBalance(`${(formatted / 1_000_000).toFixed(1)}M`);
      } else if (formatted >= 1_000) {
        setBalance(`${(formatted / 1_000).toFixed(1)}K`);
      } else if (formatted > 0) {
        setBalance(formatted.toFixed(2));
      } else {
        setBalance('0');
      }
    }).catch(() => setBalance('—'));
  }, [address, wallet]);

  return <>{balance}</>;
}

// ─── Main Dashboard ──────────────────────────────────────

export default function Dashboard() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const saved = sessionStorage.getItem('nadmail_auth');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (auth) {
      sessionStorage.setItem('nadmail_auth', JSON.stringify(auth));
    } else {
      sessionStorage.removeItem('nadmail_auth');
    }
  }, [auth]);

  const location = useLocation();
  const { disconnect } = useDisconnect();
  // Read ?claim= and ?proxybuy= parameters from URL (Landing → Dashboard flow)
  const claimName = new URLSearchParams(location.search).get('claim') || null;
  const proxyBuyName = new URLSearchParams(location.search).get('proxybuy') || null;
  // Wallet balance for sidebar display
  const walletAddr = auth?.wallet as `0x${string}` | undefined;
  const { data: monBalance } = useBalance({ address: walletAddr, chainId: MONAD_CHAIN_ID });

  // Token holdings for sidebar
  const [tokenHoldings, setTokenHoldings] = useState<{ symbol: string; address: string; balance: string; isOwn: boolean }[]>([]);
  const [showAllTokens, setShowAllTokens] = useState(false);

  // Poll for token readiness if handle exists but token_symbol is missing
  useEffect(() => {
    if (!auth?.handle || auth.handle.startsWith('0x') || auth.token_symbol) return;
    let cancelled = false;
    const poll = async () => {
      for (let i = 0; i < 12; i++) { // poll up to ~2 min
        if (cancelled) return;
        await new Promise(r => setTimeout(r, 10_000));
        if (cancelled) return;
        try {
          const res = await apiFetch('/api/register/check/' + auth.wallet, auth.token);
          const data = await res.json();
          if (data.token_symbol && data.token_address) {
            setAuth(prev => prev ? { ...prev, token_symbol: data.token_symbol, token_address: data.token_address } : prev);
            return;
          }
        } catch {}
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [auth?.handle, auth?.token_symbol]);

  // Fetch token holdings — query all NadMail tokens, then check balances
  useEffect(() => {
    if (!auth?.wallet) return;
    let cancelled = false;
    (async () => {
      try {
        // Get all NadMail tokens
        const tokensRes = await fetch(`${API_BASE}/api/stats/tokens`);
        if (!tokensRes.ok) return;
        const { tokens } = await tokensRes.json();
        if (cancelled || !tokens?.length) return;

        // Query balances via RPC multicall (batch of balanceOf calls)
        const client = createPublicClient({
          chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } },
          transport: http('https://rpc.monad.xyz'),
        });

        const balanceCalls = tokens.map((t: any) => ({
          address: t.address as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf' as const,
          args: [auth.wallet as `0x${string}`],
        }));

        // Batch in chunks of 20 to avoid RPC limits
        const holdings: { symbol: string; address: string; balance: string; isOwn: boolean; rawBalance: bigint }[] = [];
        for (let i = 0; i < balanceCalls.length; i += 20) {
          if (cancelled) return;
          const chunk = balanceCalls.slice(i, i + 20);
          try {
            const results = await client.multicall({ contracts: chunk });
            results.forEach((r: any, j: number) => {
              const token = tokens[i + j];
              if (r.status === 'success' && r.result > 0n) {
                const bal = r.result as bigint;
                const formatted = parseFloat(formatUnits(bal, 18));
                let balStr: string;
                if (formatted >= 1_000_000) balStr = `${(formatted / 1_000_000).toFixed(1)}M`;
                else if (formatted >= 1_000) balStr = `${(formatted / 1_000).toFixed(1)}K`;
                else balStr = formatted.toFixed(2);

                holdings.push({
                  symbol: token.symbol,
                  address: token.address,
                  balance: balStr,
                  isOwn: token.address === auth.token_address,
                  rawBalance: bal,
                });
              }
            });
          } catch {}
        }

        if (cancelled) return;
        // Sort: own token first, then by balance descending
        holdings.sort((a, b) => {
          if (a.isOwn) return -1;
          if (b.isOwn) return 1;
          return b.rawBalance > a.rawBalance ? 1 : -1;
        });
        setTokenHoldings(holdings.map(({ rawBalance, ...h }) => h));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [auth?.wallet, auth?.token_address]);

  if (!auth) {
    return <ConnectWallet onAuth={setAuth} />;
  }

  if (!auth.registered || !auth.handle) {
    return (
      <RegisterEmail
        auth={auth}
        onRegistered={(handle, token) => setAuth({ ...auth, handle, registered: true, token })}
        claimName={claimName}
      />
    );
  }

  const primaryEmail = `${auth.handle}@nadmail.ai`;

  return (
    <div className="min-h-screen bg-nad-dark flex">
      {/* Sidebar */}
      <aside className="w-64 bg-nad-gray border-r border-gray-800 p-6 flex flex-col">
        <Link to="/" className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 bg-nad-purple rounded-lg flex items-center justify-center text-white font-bold text-sm">
            NM
          </div>
          <span className="text-lg font-bold">NadMail</span>
        </Link>

        {/* Email address card */}
        <div className="bg-nad-dark rounded-lg p-3 mb-6">
          <div className="text-gray-400 text-xs mb-1 flex items-center gap-1">
            <span>Your Email</span>
            {auth.tier === 'pro' && <span title="NadMail Pro" style={{ color: '#FFD700' }}>&#10003;</span>}
          </div>
          <div className="text-nad-purple font-mono text-sm truncate" title={primaryEmail}>
            {truncateEmail(auth.handle!)}
          </div>
          <CopyButton text={primaryEmail} label="Copy address" />
          {auth.token_symbol && (
            <a
              href={`https://nad.fun/tokens/${auth.token_address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 text-xs mt-1 font-mono hover:text-purple-300 transition block"
            >
              ${auth.token_symbol} on nad.fun ↗
            </a>
          )}
        </div>

        <nav className="flex-1 space-y-1">
          <NavLink to="/dashboard" icon="inbox" label="Inbox" active={location.pathname === '/dashboard'} />
          <NavLink to="/dashboard/sent" icon="send" label="Sent" active={location.pathname === '/dashboard/sent'} />
          <NavLink to="/dashboard/compose" icon="edit" label="Compose" active={location.pathname === '/dashboard/compose'} />
          <NavLink to="/dashboard/credits" icon="credits" label="Credits" active={location.pathname === '/dashboard/credits'} />
          {(auth.handle === 'diplomat' || auth.handle === 'nadmail') && (
            <NavLink to="/dashboard/agent" icon="agent" label="Agent" active={location.pathname === '/dashboard/agent'} />
          )}
          <NavLink to="/dashboard/settings" icon="settings" label="Settings" active={location.pathname === '/dashboard/settings'} />
        </nav>

        <div className="mt-auto pt-6 border-t border-gray-800">
          {/* Wallet balance */}
          <div className="mb-3 space-y-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Balance</div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">MON</span>
              <span className="text-gray-300 font-mono">{monBalance ? parseFloat(formatUnits(monBalance.value, 18)).toFixed(4) : '—'}</span>
            </div>
            {tokenHoldings.slice(0, 4).map(t => (
              <div key={t.address} className="flex items-center justify-between text-xs">
                <a
                  href={`https://nad.fun/tokens/${t.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${t.isOwn ? 'text-nad-purple' : 'text-purple-400'} hover:text-purple-300 transition font-mono`}
                >
                  ${t.symbol}
                </a>
                <span className="text-gray-300 font-mono">{t.balance}</span>
              </div>
            ))}
            {tokenHoldings.length > 4 && (
              <button
                onClick={() => setShowAllTokens(true)}
                className="text-[10px] text-gray-500 hover:text-gray-300 transition mt-1"
              >
                View all {tokenHoldings.length} tokens →
              </button>
            )}
          </div>

          <div className="text-xs text-gray-500 font-mono truncate mb-2" title={auth.wallet}>
            {auth.wallet.slice(0, 6)}...{auth.wallet.slice(-4)}
          </div>
          <button
            onClick={() => {
              sessionStorage.removeItem('nadmail_auth');
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
        {auth.handle?.startsWith('0x') && (
          <UpgradeBanner auth={auth} setAuth={setAuth} claimName={claimName} />
        )}
        {proxyBuyName && (
          <ProxyBuyBanner auth={auth} setAuth={setAuth} name={proxyBuyName} />
        )}
        <Routes>
          <Route index element={<Inbox auth={auth} folder="inbox" />} />
          <Route path="sent" element={<Inbox auth={auth} folder="sent" />} />
          <Route path="compose" element={<Compose auth={auth} />} />
          <Route path="credits" element={<Credits auth={auth} />} />
          <Route path="agent" element={<AgentActivity auth={auth} />} />
          <Route path="settings" element={<Settings auth={auth} setAuth={setAuth} />} />
          <Route path="email/:id" element={<EmailDetail auth={auth} />} />
        </Routes>
      </main>

      {/* All Tokens Modal */}
      {showAllTokens && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-nad-gray rounded-xl p-6 max-w-md w-full border border-gray-800 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Token Holdings</h3>
              <button onClick={() => setShowAllTokens(false)} className="text-gray-500 hover:text-white text-xl">&times;</button>
            </div>
            <div className="space-y-2">
              {tokenHoldings.map(t => (
                <div key={t.address} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <a href={`https://nad.fun/tokens/${t.address}`} target="_blank" rel="noopener noreferrer"
                    className={`${t.isOwn ? 'text-nad-purple' : 'text-purple-400'} font-mono text-sm hover:text-purple-300 transition`}>
                    ${t.symbol} {t.isOwn && <span className="text-gray-600 text-xs">(yours)</span>}
                  </a>
                  <span className="text-gray-300 font-mono text-sm">{t.balance}</span>
                </div>
              ))}
              {tokenHoldings.length === 0 && (
                <p className="text-gray-500 text-center py-4">No tokens yet</p>
              )}
            </div>
          </div>
        </div>
      )}
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
    agent: '\u{1F916}',
  };
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
        active ? 'bg-nad-purple/10 text-nad-purple' : 'text-gray-400 hover:text-white hover:bg-gray-800'
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
        tier: data.tier || 'free',
        token_address: data.token_address || null,
        token_symbol: data.token_symbol || null,
        pending_emails: data.pending_emails || 0,
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
    <div className="min-h-screen bg-nad-dark flex items-center justify-center">
      <div className="bg-nad-gray rounded-xl p-8 max-w-md w-full text-center border border-gray-800">
        <div className="w-16 h-16 bg-nad-purple rounded-xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-6">
          NM
        </div>
        <h1 className="text-2xl font-bold mb-2">NadMail Dashboard</h1>
        <p className="text-gray-400 mb-8">Connect your wallet to access your agent's email.</p>

        {error && (
          <div className="bg-red-900/20 border border-red-800 text-red-400 text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        {status ? (
          <div className="text-nad-purple text-sm font-mono py-3">{status}</div>
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
                    ? 'w-full bg-nad-purple text-white py-3 rounded-lg font-medium hover:bg-purple-600 transition disabled:opacity-50'
                    : 'w-full bg-transparent text-white py-3 rounded-lg font-medium border border-gray-600 hover:border-nad-purple hover:text-nad-purple transition disabled:opacity-50'
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

// ─── Register Email (Name Picker) ───────────────────────
interface FreeName {
  name: string;
  description: string;
  available: boolean;
}

function RegisterEmail({
  auth,
  onRegistered,
  claimName,
}: {
  auth: AuthState;
  onRegistered: (handle: string, token: string) => void;
  claimName?: string | null;
}) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [claimedHandle, setClaimedHandle] = useState('');
  const [claimedHasToken, setClaimedHasToken] = useState(false);

  const [freeNames, setFreeNames] = useState<FreeName[]>([]);
  const [ownedNames, setOwnedNames] = useState<NadNameInfo[]>([]);
  const [loadingNames, setLoadingNames] = useState(true);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [nameSource, setNameSource] = useState<'free' | 'owned' | 'purchasable' | null>(null);

  // Proxy purchase state
  const [purchaseInfo, setPurchaseInfo] = useState<any>(null);
  const [purchaseStep, setPurchaseStep] = useState<'idle' | 'quoting' | 'paying' | 'confirming' | 'success' | 'error'>('idle');
  const [purchaseError, setPurchaseError] = useState('');

  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  const walletAddr = auth.wallet as `0x${string}` | undefined;
  const { data: monBalance } = useBalance({ address: walletAddr, chainId: MONAD_CHAIN_ID });

  const shortAddr = auth.wallet ? `${auth.wallet.slice(0, 6)}...${auth.wallet.slice(-4)}` : '';

  // Load free names + owned .nad names on mount
  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/register/free-names`).then((r) => r.json()).catch(() => ({ names: [] })),
      fetch(`${API_BASE}/api/register/nad-names/${auth.wallet}`).then((r) => r.json()).catch(() => ({ names: [] })),
    ]).then(([freeData, ownedData]) => {
      const free = freeData.names || [];
      setFreeNames(free);
      const available = (ownedData.names || []).filter((n: NadNameInfo) => n.available);
      setOwnedNames(available);

      // Auto-select from ?claim= parameter
      if (claimName) {
        const inOwned = available.find((n: NadNameInfo) => n.name === claimName);
        if (inOwned) {
          setSelectedName(inOwned.name);
          setNameSource('owned');
        } else {
          const inFree = free.find((n: { name: string; available: boolean }) => n.name === claimName && n.available);
          if (inFree) {
            setSelectedName(inFree.name);
            setNameSource('free');
          } else {
            // Not in owned or free — check if purchasable on NNS
            fetch(`${API_BASE}/api/register/nad-name-price/${encodeURIComponent(claimName)}`)
              .then((r) => r.ok ? r.json() : null)
              .then((data) => {
                if (data && data.available_nns && data.available_nadmail) {
                  setPurchaseInfo(data);
                  setSelectedName(claimName);
                  setNameSource('purchasable');
                }
              })
              .catch(() => {});
          }
        }
      }
    }).finally(() => setLoadingNames(false));
  }, [auth.wallet, claimName]);

  async function handlePurchase() {
    if (!selectedName || !purchaseInfo) return;
    setPurchaseError('');

    try {
      // Direct Buy: user's wallet calls NNS registrar directly (same as ProxyBuyBanner)
      // Step 1: Get signature + calldata from our API
      setPurchaseStep('quoting');
      const buyerAddr = auth.wallet;

      const signRes = await fetch(`${API_BASE}/api/register/nad-name-sign/${encodeURIComponent(selectedName)}?buyer=${buyerAddr}`);
      const signData = await signRes.json();
      if (!signRes.ok || !signData.signature) {
        throw new Error(signData.error || 'Failed to prepare registration');
      }

      // Step 2: Send TX directly to NNS registrar via user's wallet
      setPurchaseStep('paying');
      try { await switchChainAsync({ chainId: MONAD_CHAIN_ID }); } catch {}

      const priceWei = BigInt(signData.value || purchaseInfo.discounted_price_wei || purchaseInfo.price_wei);

      const txHash = await sendTransactionAsync({
        to: NNS_REGISTRAR_ADDR as `0x${string}`,
        data: signData.calldata as `0x${string}`,
        value: priceWei,
        chainId: MONAD_CHAIN_ID,
      });

      // Step 3: Wait for on-chain confirmation
      setPurchaseStep('confirming');
      const monadClient = createPublicClient({
        chain: { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } },
        transport: http('https://rpc.monad.xyz'),
      });

      const receipt = await monadClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== 'success') {
        throw new Error('Transaction failed on-chain');
      }

      // Step 4: Register on NadMail (new user) or upgrade handle (existing 0x user)
      setPurchaseStep('success');

      // Try to register / upgrade
      await handleRegister(selectedName);
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Transaction failed';
      if (msg.includes('User rejected') || msg.includes('denied')) {
        setPurchaseError('Transaction cancelled. You can try again.');
      } else {
        setPurchaseError(msg);
      }
      setPurchaseStep('idle');
    }
  }

  async function handleRegister(handle?: string) {
    setSubmitting(true);
    setError('');
    try {
      const body = handle ? { handle } : {};
      const res = await apiFetch('/api/register', auth.token, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setClaimedHandle(data.handle);
      setClaimedHasToken(!!data.token_address || !!handle);
      setClaimed(true);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Success screen
  if (claimed) {
    const claimedEmail = `${claimedHandle}@nadmail.ai`;

    return (
      <div className="min-h-screen bg-nad-dark flex items-center justify-center p-4">
        {showConfetti && <ConfettiEffect />}

        <div className="bg-nad-gray rounded-xl p-8 max-w-md w-full border border-gray-800 text-center">
          <div className="text-5xl mb-4">&#127881;</div>
          <h1 className="text-2xl font-bold text-nad-purple mb-1 break-all">
            {claimedEmail}
          </h1>
          <p className="text-green-400 font-medium text-lg mb-2">is yours!</p>
          {claimedHasToken ? (
            <p className="text-purple-400 text-sm mb-6 font-mono">
              ${claimedHandle.toUpperCase()} token created on nad.fun
            </p>
          ) : (
            <p className="text-gray-500 text-sm mb-6">
              Basic email — no token (pick a .nad name next time!)
            </p>
          )}

          <button
            onClick={() => onRegistered(claimedHandle, auth.token)}
            className="w-full bg-nad-purple text-white py-3 rounded-lg font-medium hover:bg-purple-600 transition text-lg"
          >
            Enter Inbox &#8594;
          </button>
        </div>
      </div>
    );
  }

  const availableFreeNames = freeNames.filter((n) => n.available);
  const hasFreeNames = availableFreeNames.length > 0;
  const hasOwnedNames = ownedNames.length > 0;
  const hasPurchasable = nameSource === 'purchasable' && purchaseInfo;
  const hasAnyNames = hasFreeNames || hasOwnedNames || hasPurchasable;

  // Name picker screen
  return (
    <div className="min-h-screen bg-nad-dark flex items-center justify-center p-4">
      <div className="bg-nad-gray rounded-xl p-6 sm:p-8 max-w-2xl w-full border border-gray-800">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold mb-2">Pick Your .nad Name</h1>
          <p className="text-gray-400">
            {hasOwnedNames
              ? 'Use your own .nad name or claim a free one!'
              : hasFreeNames
              ? `Choose a legendary name — free! (${availableFreeNames.length} left)`
              : 'Get your NadMail email address'}
          </p>
          <p className="text-gray-600 text-xs mt-1">
            Wallet: <span className="text-gray-400">{shortAddr}</span>
          </p>
        </div>

        {loadingNames ? (
          <div className="text-center py-8 text-gray-500">Loading names...</div>
        ) : hasAnyNames ? (
          <>
            {/* Owned .nad names section */}
            {hasOwnedNames && (
              <div className="mb-6">
                <h3 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                  Your .nad Names
                  <span className="text-xs font-normal text-gray-500">({ownedNames.length})</span>
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {ownedNames.map((n) => {
                    const isSelected = selectedName === n.name && nameSource === 'owned';
                    return (
                      <button
                        key={`owned-${n.name}`}
                        onClick={() => { setSelectedName(n.name); setNameSource('owned'); }}
                        className={`rounded-lg p-3 text-left transition border ${
                          isSelected
                            ? 'border-nad-purple bg-purple-900/30 ring-2 ring-nad-purple'
                            : 'border-purple-700/50 bg-purple-900/10 hover:border-purple-600 hover:bg-purple-900/20 cursor-pointer'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-sm text-nad-purple">{n.name}.nad</span>
                          <span className="text-purple-400 text-xs">Yours</span>
                        </div>
                        <div className="text-xs text-gray-500">Use your own name</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Free names section */}
            {hasFreeNames && (
              <div className="mb-6">
                {hasOwnedNames && (
                  <h3 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                    Free Names
                    <span className="text-xs font-normal text-gray-500">({availableFreeNames.length} available)</span>
                  </h3>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {freeNames.map((n) => {
                    const isSelected = selectedName === n.name && nameSource === 'free';
                    const isAvailable = n.available;

                    return (
                      <button
                        key={n.name}
                        onClick={() => { if (isAvailable) { setSelectedName(n.name); setNameSource('free'); } }}
                        disabled={!isAvailable}
                        className={`rounded-lg p-3 text-left transition border ${
                          isSelected
                            ? 'border-nad-purple bg-purple-900/30 ring-2 ring-nad-purple'
                            : isAvailable
                            ? 'border-gray-700 bg-nad-dark hover:border-purple-600 hover:bg-purple-900/10 cursor-pointer'
                            : 'border-gray-800 bg-gray-900/50 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`font-mono font-bold text-sm ${
                            isAvailable ? 'text-nad-purple' : 'text-gray-600 line-through'
                          }`}>
                            {n.name}.nad
                          </span>
                          {isAvailable ? (
                            <span className="text-green-500 text-xs">Free</span>
                          ) : (
                            <span className="text-gray-600 text-xs">Claimed</span>
                          )}
                        </div>
                        <div className={`text-xs ${isAvailable ? 'text-gray-500' : 'text-gray-700'}`}>
                          {n.description.split(' — ')[0]}
                        </div>
                        <div className={`text-[10px] mt-1 ${isAvailable ? 'text-gray-600' : 'text-gray-700'}`}>
                          {n.description.split(' — ')[1] || ''}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Purchasable name from ?claim= */}
            {purchaseInfo && (
              <div className="mb-6">
                <h3 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                  Your Requested Name
                </h3>
                <button
                  onClick={() => { setSelectedName(purchaseInfo.name); setNameSource('purchasable'); }}
                  className={`w-full rounded-lg p-4 text-left transition border ${
                    nameSource === 'purchasable'
                      ? 'border-yellow-500 bg-yellow-900/20 ring-2 ring-yellow-500'
                      : 'border-yellow-700/50 bg-yellow-900/10 hover:border-yellow-600 hover:bg-yellow-900/20 cursor-pointer'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-bold text-lg text-nad-purple">{purchaseInfo.name}.nad</span>
                    <span className="text-yellow-400 text-xs font-medium px-2 py-0.5 bg-yellow-900/30 rounded">Purchase</span>
                  </div>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Base:</span>
                      <span className={`font-mono ${purchaseInfo.discount ? 'line-through text-gray-600' : 'text-gray-300'}`}>{purchaseInfo.price_mon.toFixed(2)} MON</span>
                    </div>
                    {purchaseInfo.discount && (
                      <div className="flex justify-between">
                        <span className="text-green-400">Discount: {purchaseInfo.discount.description}</span>
                        <span className="text-green-400 font-mono">-{purchaseInfo.discount.percent}%</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total:</span>
                      <span className="text-yellow-300 font-mono font-bold">{(purchaseInfo.discounted_price_mon || purchaseInfo.price_mon).toFixed(2)} MON</span>
                    </div>
                  </div>
                  {monBalance && (() => {
                    const bal = parseFloat(formatUnits(monBalance.value, monBalance.decimals));
                    const cost = purchaseInfo.discounted_price_mon || purchaseInfo.price_mon;
                    return (
                      <div className={`mt-2 text-xs ${bal >= cost ? 'text-green-400' : 'text-red-400'}`}>
                        Your balance: {bal.toFixed(2)} MON
                        {bal >= cost ? ' — Sufficient' : ' — Insufficient'}
                      </div>
                    );
                  })()}
                </button>
              </div>
            )}

            {/* Selected preview */}
            {selectedName && (
              <div className="bg-nad-dark rounded-lg p-4 mb-4 border border-purple-800">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-nad-purple font-mono font-bold text-lg">
                      {selectedName}@nadmail.ai
                    </div>
                    {nameSource === 'purchasable' ? (
                      <div className="text-yellow-400 text-xs font-mono mt-1">
                        Buy {selectedName}.nad + create ${selectedName.toUpperCase()} token
                      </div>
                    ) : (
                      <div className="text-purple-400 text-xs font-mono mt-1">
                        Token: ${selectedName.toUpperCase()} on nad.fun
                      </div>
                    )}
                  </div>
                  <div className="text-3xl">&#9993;</div>
                </div>
              </div>
            )}

            {auth.pending_emails && auth.pending_emails > 0 ? (
              <div className="bg-purple-900/20 border border-purple-800 text-purple-300 text-sm rounded-lg p-3 mb-4">
                You have <span className="font-bold">{auth.pending_emails}</span> email{auth.pending_emails > 1 ? 's' : ''} waiting!
              </div>
            ) : null}

            {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
            {purchaseError && <p className="text-red-400 text-sm mb-4">{purchaseError}</p>}

            {/* Purchase progress */}
            {purchaseStep !== 'idle' && purchaseStep !== 'error' && (
              <div className="bg-nad-dark rounded-lg p-3 mb-4 border border-yellow-800">
                <div className="flex items-center gap-3">
                  <div className="animate-spin w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full" />
                  <span className="text-yellow-300 text-sm">
                    {purchaseStep === 'quoting' && 'Preparing registration...'}
                    {purchaseStep === 'paying' && 'Confirm transaction in your wallet...'}
                    {purchaseStep === 'confirming' && 'Waiting for on-chain confirmation...'}
                    {purchaseStep === 'success' && 'Purchase complete!'}
                  </span>
                </div>
              </div>
            )}

            {/* Claim / Buy button */}
            {nameSource === 'purchasable' ? (
              <button
                onClick={handlePurchase}
                disabled={purchaseStep !== 'idle' && purchaseStep !== 'error'}
                className="w-full bg-yellow-600 text-white py-3 rounded-lg font-medium hover:bg-yellow-500 transition disabled:opacity-50 text-lg mb-3"
              >
                {purchaseStep === 'idle' || purchaseStep === 'error'
                  ? `Buy ${selectedName}.nad — ${purchaseInfo?.discounted_price_mon?.toFixed(2) || purchaseInfo?.proxy_buy?.total_mon?.toFixed(2) || purchaseInfo?.price_mon?.toFixed(2)} MON`
                  : purchaseStep === 'quoting' ? 'Preparing...'
                  : purchaseStep === 'paying' ? 'Confirm in wallet...'
                  : purchaseStep === 'confirming' ? 'Confirming on-chain...'
                  : 'Done!'}
              </button>
            ) : (
              <button
                onClick={() => handleRegister(selectedName!)}
                disabled={submitting || !selectedName}
                className="w-full bg-nad-purple text-white py-3 rounded-lg font-medium hover:bg-purple-600 transition disabled:opacity-50 text-lg mb-3"
              >
                {submitting
                  ? 'Creating token...'
                  : selectedName
                  ? `Claim ${selectedName}@nadmail.ai + $${selectedName.toUpperCase()}`
                  : 'Select a name above'}
              </button>
            )}

            {/* Skip option */}
            <button
              onClick={() => handleRegister()}
              disabled={submitting}
              className="w-full text-gray-500 hover:text-gray-300 text-sm py-2 transition"
            >
              Skip — use wallet address instead (no token)
            </button>
          </>
        ) : (
          <>
            {/* No free names + no owned names — guide to buy */}
            <div className="bg-nad-dark rounded-lg p-6 mb-4 border border-gray-700">
              <p className="text-gray-400 mb-2 text-center">All free names have been claimed!</p>
              <p className="text-gray-500 text-sm mb-4 text-center">
                Get your own .nad name to unlock a memorable email + meme coin.
              </p>

              {/* Pricing reference */}
              <div className="bg-gray-800/50 rounded-lg p-3 mb-4">
                <p className="text-gray-500 text-xs font-medium mb-2 uppercase tracking-wide">.nad Name Pricing</p>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-gray-400">5+ characters</span><span className="text-gray-300 font-mono">~691 MON</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">4 characters</span><span className="text-gray-300 font-mono">~1,726 MON</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">3 characters</span><span className="text-gray-300 font-mono">~5,694 MON</span></div>
                </div>
              </div>

              {/* MON Balance */}
              {monBalance && (
                <div className={`rounded-lg p-3 mb-4 text-sm text-center ${
                  parseFloat(formatUnits(monBalance.value, monBalance.decimals)) >= 691
                    ? 'bg-green-900/20 border border-green-800 text-green-400'
                    : 'bg-gray-800/50 text-gray-400'
                }`}>
                  Your balance: <span className="font-mono font-medium">
                    {parseFloat(formatUnits(monBalance.value, monBalance.decimals)).toFixed(2)} MON
                  </span>
                  {parseFloat(formatUnits(monBalance.value, monBalance.decimals)) >= 691 && (
                    <span className="ml-1 text-green-300">— Enough for a 5+ char name!</span>
                  )}
                </div>
              )}

              <div className="text-center">
                <a
                  href="https://app.nad.domains"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block bg-purple-800/50 text-purple-300 px-6 py-2 rounded-lg hover:bg-purple-800/70 transition text-sm font-medium border border-purple-700/50"
                >
                  Buy a .nad name &rarr;
                </a>
                <p className="text-gray-600 text-xs mt-3">
                  After buying, come back and refresh this page to use your name.
                </p>
              </div>
            </div>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-700"></div></div>
              <div className="relative flex justify-center text-xs"><span className="bg-nad-gray px-3 text-gray-500">or</span></div>
            </div>

            <div className="bg-nad-dark rounded-lg p-4 mb-4 border border-gray-700 text-center">
              <p className="text-gray-500 text-sm">
                Use your wallet address: <span className="text-gray-300 font-mono">{auth.wallet.toLowerCase().slice(0, 10)}@nadmail.ai</span>
              </p>
            </div>

            {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

            <button
              onClick={() => handleRegister()}
              disabled={submitting}
              className="w-full bg-gray-700 text-white py-3 rounded-lg font-medium hover:bg-gray-600 transition disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Get Wallet Email (no token)'}
            </button>
          </>
        )}
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
            <span className="ml-2 text-sm bg-nad-purple text-white px-2 py-0.5 rounded-full">
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
              className={`block px-4 py-3 rounded-lg hover:bg-nad-gray transition ${
                !email.read ? 'bg-nad-gray/50' : ''
              }`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${!email.read ? 'bg-nad-purple' : 'bg-transparent'}`} />
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
                    {email.microbuy_tx && (
                      <span className="text-purple-400 text-xs font-bold bg-purple-900/30 px-1.5 py-0.5 rounded" title="Micro-buy triggered">
                        micro-buy
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
        <Link to="/dashboard" className="text-nad-purple hover:underline">Back to Inbox</Link>
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
          className="text-nad-purple hover:underline text-sm"
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

      <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
        <h2 className="text-xl font-bold mb-4">{email.subject || '(no subject)'}</h2>

        {/* Micro-buy banner */}
        {email.microbuy_tx && (
          <div className="bg-purple-900/20 border border-purple-700/50 rounded-lg p-4 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">&#x1F4B0;</span>
              <div>
                <div className="text-purple-400 font-bold">Micro-buy: 0.001 MON</div>
                <div className="text-purple-600 text-xs">Token investment triggered by this email</div>
              </div>
            </div>
            <a
              href={`${MONAD_EXPLORER}/tx/${email.microbuy_tx}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-500 hover:text-purple-400 text-xs underline"
            >
              View on Explorer
            </a>
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
  const { data: monBal } = useBalance({ address: walletAddr, chainId: MONAD_CHAIN_ID });
  const [credits, setCredits] = useState<number>(0);
  const [amount, setAmount] = useState('1');
  const [txHash, setTxHash] = useState('');
  const [status, setStatus] = useState<'idle' | 'paying' | 'confirming' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);
  const [tab, setTab] = useState<'wallet' | 'api'>('wallet');

  useEffect(() => {
    apiFetch('/api/credits', auth.token)
      .then((r) => r.json())
      .then((data) => setCredits(data.credits || 0));
  }, [auth.token]);

  const creditsForAmount = Math.floor(parseFloat(amount || '0') * 7);

  async function handleWalletPay() {
    setStatus('paying');
    setError('');
    try {
      const payAmount = parseEther(amount);
      try { await switchChainAsync({ chainId: MONAD_CHAIN_ID }); } catch {}

      const hash = await sendTransactionAsync({
        to: DEPOSIT_ADDRESS as `0x${string}`,
        value: payAmount,
        chainId: MONAD_CHAIN_ID,
      });
      setTxHash(hash);
      setStatus('confirming');

      const res = await apiFetch('/api/credits/buy', auth.token, {
        method: 'POST',
        body: JSON.stringify({ tx_hash: hash }),
      });
      const data = await res.json();
      if (!res.ok) {
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
        body: JSON.stringify({ tx_hash: txHash }),
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

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      {showConfetti && <ConfettiEffect />}

      <div className="bg-nad-gray rounded-xl p-6 max-w-md w-full border border-gray-800 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">Buy Email Credits</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">&times;</button>
        </div>

        <div className="bg-nad-dark rounded-lg p-3 mb-4 flex items-center justify-between">
          <span className="text-gray-400 text-sm">Current Balance</span>
          <span className="text-2xl font-bold text-nad-purple">{credits}</span>
        </div>

        {status === 'success' ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">&#127881;</div>
            <h4 className="text-xl font-bold text-green-400 mb-2">Credits Added!</h4>
            <p className="text-gray-400 mb-4">You now have <span className="text-nad-purple font-bold">{credits}</span> credits</p>
            <button
              onClick={onSuccess}
              className="bg-nad-purple text-white px-8 py-3 rounded-lg font-medium hover:bg-purple-600 transition"
            >
              OK, Send Email
            </button>
          </div>
        ) : (
          <>
            <div className="flex gap-1 bg-nad-dark rounded-lg p-1 mb-4">
              <button
                onClick={() => setTab('wallet')}
                className={`flex-1 py-2 rounded-md text-sm transition ${tab === 'wallet' ? 'bg-nad-purple text-white' : 'text-gray-400 hover:text-white'}`}
              >
                Pay with Wallet
              </button>
              <button
                onClick={() => setTab('api')}
                className={`flex-1 py-2 rounded-md text-sm transition ${tab === 'api' ? 'bg-nad-purple text-white' : 'text-gray-400 hover:text-white'}`}
              >
                API / Agent
              </button>
            </div>

            {tab === 'wallet' ? (
              <>
                <div className="text-sm text-gray-400 mb-4 space-y-1">
                  <p>1 credit = 1 external email</p>
                  <p>1 MON = 7 credits (min: 1 MON)</p>
                  {monBal && <p className="text-gray-500">Balance: {parseFloat(formatUnits(monBal.value, 18)).toFixed(4)} MON</p>}
                </div>

                <div className="mb-4">
                  <label className="text-gray-400 text-xs mb-1 block">Amount (MON)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      className="flex-1 bg-nad-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-nad-purple"
                    />
                    <span className="bg-nad-dark border border-gray-700 rounded-lg px-3 py-2 text-gray-400 text-sm">
                      = {creditsForAmount.toLocaleString()} credits
                    </span>
                  </div>
                </div>

                <div className="text-center mb-4">
                  <div className="font-mono text-xs text-gray-400 break-all px-4">{DEPOSIT_ADDRESS}</div>
                  <CopyButton text={DEPOSIT_ADDRESS} label="Copy address" />
                </div>

                {status === 'confirming' ? (
                  <div className="mb-2 bg-nad-dark rounded-lg p-3 border border-gray-700">
                    <ChainSearchSpinner maxSeconds={60} />
                  </div>
                ) : (
                  <button
                    onClick={handleWalletPay}
                    disabled={status === 'paying' || !amount || parseFloat(amount) < 0.1}
                    className="w-full bg-nad-purple text-white py-3 rounded-lg font-medium hover:bg-purple-600 transition disabled:opacity-50 mb-2"
                  >
                    {status === 'paying' ? 'Confirm in wallet...' : `Pay ${amount} MON`}
                  </button>
                )}

                <div className="mt-3 pt-3 border-t border-gray-800">
                  <label className="text-gray-500 text-xs mb-1 block">Already paid? Paste tx hash:</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={txHash}
                      onChange={(e) => setTxHash(e.target.value)}
                      placeholder="0x..."
                      className="flex-1 bg-nad-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-nad-purple"
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
              <div className="text-sm space-y-3">
                <p className="text-gray-400">
                  For AI Agents: send MON on Monad chain to the deposit address, then submit the tx hash via API.
                </p>
                <div className="bg-nad-dark rounded-lg p-3 font-mono text-xs text-gray-300 space-y-2">
                  <div className="text-gray-500"># 1. Send MON on Monad to:</div>
                  <div className="text-nad-purple break-all">{DEPOSIT_ADDRESS}</div>
                  <div className="text-gray-500 mt-2"># 2. Submit tx hash:</div>
                  <div className="text-green-400">{`POST /api/credits/buy`}</div>
                  <div className="text-gray-400">{`{ "tx_hash": "0x..." }`}</div>
                  <div className="text-gray-500 mt-2"># Pricing:</div>
                  <div className="text-gray-400">
                    1 MON = 7 credits<br />
                    Min: 1 MON = 7 credits<br />
                    1 credit = 1 external email (~$0.003)
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
  const [emoChip, setEmoChip] = useState<string | null>(null);
  const [emoCustom, setEmoCustom] = useState('');

  const EMO_PRESETS = [
    { id: 'friendly', emoji: '\u{1F60A}', label: 'Friendly', amount: 0.01 },
    { id: 'bullish', emoji: '\u{1F60D}', label: 'Bullish', amount: 0.025 },
    { id: 'super', emoji: '\u{1F525}', label: 'Super Bullish', amount: 0.05 },
    { id: 'moon', emoji: '\u{1F680}', label: 'Moon', amount: 0.075 },
    { id: 'wagmi', emoji: '\u{1F48E}', label: 'WAGMI', amount: 0.1 },
    { id: 'custom', emoji: '\u{270F}\u{FE0F}', label: 'Custom', amount: 0 },
  ];

  const isInternalRecipient = to.toLowerCase().endsWith('@nadmail.ai');
  const emoAmount = emoChip === 'custom'
    ? Math.min(Math.max(parseFloat(emoCustom) || 0, 0), 0.1)
    : (EMO_PRESETS.find(p => p.id === emoChip)?.amount || 0);

  async function handleSend() {
    if (!to || !subject || !body) {
      setError('All fields are required');
      return;
    }

    setSending(true);
    setError('');
    try {
      const sendBody: Record<string, unknown> = { to, subject, body };
      if (emoAmount > 0 && isInternalRecipient) {
        sendBody.emo_amount = emoAmount;
      }
      const res = await apiFetch('/api/send', auth.token, {
        method: 'POST',
        body: JSON.stringify(sendBody),
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
          <div className="bg-nad-gray rounded-lg px-4 py-3 font-mono text-nad-purple border border-gray-800 text-sm truncate" title={`${auth.handle}@nadmail.ai`}>
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
            className="w-full bg-nad-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-nad-purple"
          />
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject"
            className="w-full bg-nad-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-nad-purple"
          />
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message..."
            rows={10}
            className="w-full bg-nad-gray border border-gray-800 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-nad-purple resize-y"
          />
        </div>

        {isInternalRecipient && (
          <div className="bg-nad-gray border border-gray-800 rounded-lg p-4">
            <div className="text-sm text-gray-400 mb-3">{'\u{1F4B0}'} Emo-Boost — pump their coin with your email!</div>
            <div className="flex flex-wrap gap-2 mb-2">
              {EMO_PRESETS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setEmoChip(emoChip === p.id ? null : p.id)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                    emoChip === p.id
                      ? 'bg-nad-purple text-white border border-nad-purple'
                      : 'bg-gray-800 text-gray-300 border border-gray-700 hover:border-gray-500'
                  }`}
                >
                  {p.emoji} {p.label}
                </button>
              ))}
            </div>
            {emoChip === 'custom' && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="number"
                  min="0.001"
                  max="0.1"
                  step="0.001"
                  value={emoCustom}
                  onChange={(e) => setEmoCustom(e.target.value)}
                  placeholder="0.01"
                  className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-nad-purple"
                />
                <span className="text-gray-400 text-sm">MON (max 0.1)</span>
              </div>
            )}
            {emoAmount > 0 && (
              <div className="text-xs text-gray-500 mt-2">
                Total buy: {(0.001 + emoAmount).toFixed(3)} MON (base 0.001 + boost {emoAmount})
              </div>
            )}
          </div>
        )}

        {error && <div className="text-red-400 text-sm">{error}</div>}

        <button
          onClick={handleSend}
          disabled={sending}
          className="bg-nad-purple text-white px-8 py-3 rounded-lg font-medium hover:bg-purple-600 transition disabled:opacity-50"
        >
          {sending ? 'Sending...' : emoAmount > 0 ? `Send + Boost ${emoAmount} MON` : 'Send'}
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
        <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
          <div className="text-gray-400 text-sm mb-1">Balance</div>
          <div className="text-4xl font-bold text-nad-purple">{credits}</div>
          <div className="text-gray-500 text-sm mt-1">
            1 credit = 1 external email
          </div>
          <button
            onClick={() => setShowBuyCredits(true)}
            className="mt-4 bg-nad-purple text-white px-6 py-2 rounded-lg font-medium hover:bg-purple-600 transition text-sm"
          >
            Buy Credits
          </button>
        </div>

        {pricing && (
          <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
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
          <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
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
        <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
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
              className="flex-1 bg-nad-dark border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:border-nad-purple"
            />
            <button
              onClick={async () => {
                if (!recoverHash || !recoverHash.startsWith('0x')) {
                  setRecoverMsg('Please enter a valid transaction hash');
                  setRecoverStatus('error');
                  return;
                }
                setRecoverStatus('checking');
                setRecoverMsg('Checking Monad...');
                try {
                  const res = await apiFetch('/api/credits/buy', auth.token, {
                    method: 'POST',
                    body: JSON.stringify({ tx_hash: recoverHash }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error);
                  setRecoverStatus('success');
                  setRecoverMsg(`Recovered ${data.purchased} credits from ${data.chain || 'on-chain'} payment (${data.mon_spent} MON)`);
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
function Settings({ auth, setAuth }: { auth: AuthState; setAuth: (a: AuthState) => void }) {
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const [webhook, setWebhook] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [proStatus, setProStatus] = useState<'idle' | 'paying' | 'confirming' | 'success' | 'error'>('idle');
  const [proError, setProError] = useState('');
  const [showProConfetti, setShowProConfetti] = useState(false);

  const fullEmail = `${auth.handle}@nadmail.ai`;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>
      <div className="max-w-2xl space-y-6">
        <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">Account</h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Email</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-nad-purple text-xs break-all">{fullEmail}</span>
                <CopyButton text={fullEmail} />
              </div>
            </div>
            {auth.token_symbol && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Token</span>
                <a
                  href={`https://nad.fun/tokens/${auth.token_address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-nad-purple text-xs font-bold hover:text-purple-300 transition"
                >
                  ${auth.token_symbol} ↗
                </a>
              </div>
            )}
            {auth.token_address && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Token Address</span>
                <a href={`${MONAD_EXPLORER}/address/${auth.token_address}`} target="_blank" rel="noopener noreferrer" className="font-mono text-nad-purple text-xs hover:underline">
                  {auth.token_address.slice(0, 6)}...{auth.token_address.slice(-4)}
                </a>
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

        {/* NadMail Pro */}
        <div className={`rounded-xl p-6 border ${auth.tier === 'pro' ? 'bg-gradient-to-r from-yellow-900/20 to-amber-900/20 border-yellow-700/50' : 'bg-nad-gray border-gray-800'}`}>
          {showProConfetti && <ConfettiEffect />}
          <h3 className="font-bold mb-4 flex items-center gap-2">
            {auth.tier === 'pro' ? (
              <><span style={{ color: '#FFD700' }}>&#10003;</span> NadMail Pro</>
            ) : (
              'NadMail Pro'
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
                Remove the NadMail signature from your emails and get a gold badge. One-time lifetime purchase.
              </p>
              <div className="bg-nad-dark rounded-lg p-4 border border-gray-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-gray-400 text-sm">Price</span>
                  <span className="text-xl font-bold text-nad-purple">1 MON</span>
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
                      try { await switchChainAsync({ chainId: MONAD_CHAIN_ID }); } catch {}
                      const hash = await sendTransactionAsync({
                        to: DEPOSIT_ADDRESS as `0x${string}`,
                        value: parseEther('1'),
                        chainId: MONAD_CHAIN_ID,
                      });
                      setProStatus('confirming');
                      const res = await apiFetch('/api/pro/buy', auth.token, {
                        method: 'POST',
                        body: JSON.stringify({ tx_hash: hash, chain_id: MONAD_CHAIN_ID }),
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
                  className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 text-white py-3 rounded-lg font-medium hover:from-purple-500 hover:to-indigo-500 transition disabled:opacity-50"
                >
                  {proStatus === 'paying' ? 'Confirm in wallet...' : proStatus === 'confirming' ? 'Verifying on-chain...' : 'Upgrade to Pro'}
                </button>
              </div>
              {proError && <p className="text-red-400 text-sm">{proError}</p>}
            </div>
          )}
        </div>

        <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">Webhook Notification</h3>
          <p className="text-gray-400 text-sm mb-4">
            Get notified when new emails arrive. Set a webhook URL that NadMail will POST to.
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              value={webhook}
              onChange={(e) => { setWebhook(e.target.value); setSaved(false); }}
              placeholder="https://your-agent.example.com/webhook"
              className="flex-1 bg-nad-dark border border-gray-700 rounded-lg px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-nad-purple"
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
              className="bg-nad-purple text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-600 transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        <div className="bg-nad-gray rounded-xl p-6 border border-gray-800">
          <h3 className="font-bold mb-4">API Token</h3>
          <p className="text-gray-400 text-sm mb-4">
            Use this token in your AI Agent's API calls. It expires in 24 hours — reconnect your wallet to get a fresh one.
          </p>
          <div className="bg-nad-dark rounded-lg px-4 py-3 font-mono text-sm text-gray-300 break-all select-all cursor-pointer"
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

// ─── Agent Activity ──────────────────────────────────────

interface AgentLog {
  id: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  status: string;
  emails_processed: number;
  emails_replied: number;
  posts_created: number;
  comments_left: number;
  error_message: string | null;
}

interface AgentStats {
  total_cycles: number;
  total_emails: number;
  total_posts: number;
  total_comments: number;
  avg_duration_ms: number;
  last_run: number | null;
}

function AgentActivity({ auth }: { auth: AuthState }) {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, unknown[]>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/agent/logs?limit=50', auth.token);
        if (res.ok) {
          const data = await res.json();
          setLogs(data.logs || []);
          setStats(data.stats || null);
        }
      } catch {}
      setLoading(false);
    })();
  }, [auth.token]);

  const loadDetails = async (logId: string) => {
    if (details[logId]) {
      setExpandedId(expandedId === logId ? null : logId);
      return;
    }
    try {
      const res = await apiFetch(`/api/agent/logs/${logId}`, auth.token);
      if (res.ok) {
        const data = await res.json();
        setDetails((prev) => ({ ...prev, [logId]: data.details || [] }));
      }
    } catch {}
    setExpandedId(logId);
  };

  const formatTime = (ts: number) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      success: 'bg-green-900/50 text-green-400 border-green-800',
      partial: 'bg-yellow-900/50 text-yellow-400 border-yellow-800',
      error: 'bg-red-900/50 text-red-400 border-red-800',
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs border ${colors[status] || 'bg-gray-800 text-gray-400 border-gray-700'}`}>
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-nad-purple border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">$DIPLOMAT Agent Activity</h2>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-nad-gray rounded-xl p-4 border border-gray-800">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Total Cycles</div>
            <div className="text-2xl font-bold text-white">{stats.total_cycles}</div>
          </div>
          <div className="bg-nad-gray rounded-xl p-4 border border-gray-800">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Emails Replied</div>
            <div className="text-2xl font-bold text-nad-purple">{stats.total_emails}</div>
          </div>
          <div className="bg-nad-gray rounded-xl p-4 border border-gray-800">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Posts Created</div>
            <div className="text-2xl font-bold text-blue-400">{stats.total_posts}</div>
          </div>
          <div className="bg-nad-gray rounded-xl p-4 border border-gray-800">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Comments Left</div>
            <div className="text-2xl font-bold text-green-400">{stats.total_comments}</div>
          </div>
        </div>
      )}

      {/* Last run info */}
      {stats?.last_run && (
        <div className="text-sm text-gray-500 mb-4">
          Last run: {formatTime(stats.last_run)} | Avg duration: {(stats.avg_duration_ms / 1000).toFixed(1)}s
        </div>
      )}

      {/* Logs table */}
      {logs.length === 0 ? (
        <div className="bg-nad-gray rounded-xl p-8 border border-gray-800 text-center text-gray-500">
          No agent activity yet. The diplomat runs every 30 minutes via cron.
        </div>
      ) : (
        <div className="bg-nad-gray rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Time</th>
                <th className="text-left px-4 py-3">Duration</th>
                <th className="text-center px-4 py-3">Emails</th>
                <th className="text-center px-4 py-3">Posts</th>
                <th className="text-center px-4 py-3">Comments</th>
                <th className="text-center px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <Fragment key={log.id}>
                  <tr
                    className="border-b border-gray-800/50 hover:bg-nad-dark/50 cursor-pointer transition"
                    onClick={() => loadDetails(log.id)}
                  >
                    <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{formatTime(log.started_at)}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono">{(log.duration_ms / 1000).toFixed(1)}s</td>
                    <td className="px-4 py-3 text-center">
                      {log.emails_replied > 0 ? (
                        <span className="text-nad-purple font-bold">{log.emails_replied}</span>
                      ) : (
                        <span className="text-gray-600">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {log.posts_created > 0 ? (
                        <span className="text-blue-400 font-bold">{log.posts_created}</span>
                      ) : (
                        <span className="text-gray-600">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {log.comments_left > 0 ? (
                        <span className="text-green-400 font-bold">{log.comments_left}</span>
                      ) : (
                        <span className="text-gray-600">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">{statusBadge(log.status)}</td>
                  </tr>
                  {expandedId === log.id && details[log.id] && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-nad-dark/50">
                        {log.error_message && (
                          <div className="text-red-400 text-xs mb-2">Error: {log.error_message}</div>
                        )}
                        {details[log.id].length === 0 ? (
                          <div className="text-gray-600 text-xs">No actions this cycle</div>
                        ) : (
                          <div className="space-y-1">
                            {details[log.id].map((d: any, i: number) => (
                              <div key={i} className="text-xs font-mono text-gray-400 flex gap-2">
                                <span className={
                                  d.action?.includes('error') ? 'text-red-400' :
                                  d.action?.includes('email') ? 'text-nad-purple' :
                                  d.action?.includes('post') ? 'text-blue-400' :
                                  'text-green-400'
                                }>
                                  [{d.action}]
                                </span>
                                <span>
                                  {d.to && `to: ${d.to}`}
                                  {d.title && `"${d.title}"`}
                                  {d.postTitle && `on: "${d.postTitle}"`}
                                  {d.error && <span className="text-red-400">{d.error}</span>}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
