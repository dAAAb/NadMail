import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.PROD ? 'https://api.nadmail.ai' : '';

/* --- FAQ Accordion Item --- */
function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-800 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 px-6 text-left hover:bg-gray-800/30 transition"
      >
        <span className="font-semibold text-white pr-4">{q}</span>
        <span className="text-gray-400 text-xl flex-shrink-0 w-6 text-center transition-transform" style={{ transform: open ? 'rotate(45deg)' : 'none' }}>+</span>
      </button>
      <div
        className="overflow-hidden transition-all duration-300"
        style={{ maxHeight: open ? '200px' : '0', opacity: open ? 1 : 0 }}
      >
        <p className="px-6 pb-5 text-gray-400 text-sm leading-relaxed">{a}</p>
      </div>
    </div>
  );
}

/* --- JSON-LD structured data for AI agents --- */
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "NadMail",
  "description": "Your Email is Your Meme Coin. Register a @nadmail.ai email to auto-create a meme coin on nad.fun. Every email sent triggers a micro-buy.",
  "url": "https://nadmail.ai",
  "applicationCategory": "CommunicationApplication",
  "operatingSystem": "Any",
  "offers": {
    "@type": "Offer",
    "description": "Internal @nadmail.ai emails are free (10/day). External emails cost 1 credit each.",
    "price": "0",
    "priceCurrency": "USD"
  },
  "potentialAction": [
    { "@type": "Action", "name": "Register", "target": "https://api.nadmail.ai/api/auth/agent-register", "description": "SIWE auth + auto-register + create meme coin in one call" },
    { "@type": "Action", "name": "Send Email", "target": "https://api.nadmail.ai/api/send", "description": "Send email + micro-buy recipient's token" },
    { "@type": "Action", "name": "Check Identity", "target": "https://api.nadmail.ai/api/register/check/{address}", "description": "Preview email for any wallet" }
  ]
};

export default function Landing() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<null | {
    handle: string | null;
    email: string | null;
    registered: boolean;
    token_address?: string | null;
    token_symbol?: string | null;
    upgrade_available?: boolean;
    owned_nad_names?: string[];
    has_nad_name?: boolean;
    price_info?: { price_mon: number; proxy_buy: { total_mon: number; fee_percent: number; available: boolean } } | null;
  }>(null);
  const [checking, setChecking] = useState(false);

  function isValidInput(val: string): boolean {
    const trimmed = val.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return true;
    const handle = trimmed.toLowerCase();
    return /^[a-z0-9][a-z0-9_]*[a-z0-9]$/.test(handle) && handle.length >= 3 && handle.length <= 20;
  }

  async function handleCheck() {
    const trimmed = input.trim();
    if (!isValidInput(trimmed)) return;

    setChecking(true);
    try {
      if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
        const res = await fetch(`${API_BASE}/api/register/check/${trimmed}`);
        const data = await res.json();
        setResult(data);
      } else {
        // Handle lookup
        const res = await fetch(`${API_BASE}/api/identity/${trimmed.toLowerCase()}`);
        if (res.ok) {
          const data = await res.json();
          setResult({ ...data, registered: true });
        } else {
          const name = trimmed.toLowerCase();
          // Not registered — check NNS price
          let priceInfo = null;
          try {
            const priceRes = await fetch(`${API_BASE}/api/register/nad-name-price/${encodeURIComponent(name)}`);
            if (priceRes.ok) {
              const priceData = await priceRes.json();
              if (priceData.available_nns && priceData.available_nadmail) {
                priceInfo = priceData;
              }
            }
          } catch {}
          setResult({
            handle: name,
            email: `${name}@nadmail.ai`,
            registered: false,
            price_info: priceInfo,
          });
        }
      }
    } catch {
      setResult(null);
    } finally {
      setChecking(false);
    }
  }

  const isValid = input.trim().length > 0 && isValidInput(input);

  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(JSON_LD);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  return (
    <div className="min-h-screen bg-nad-dark">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-nad-purple rounded-lg flex items-center justify-center text-white font-bold text-sm">
            NM
          </div>
          <span className="text-xl font-bold">NadMail</span>
        </div>
        <div className="flex gap-4 items-center">
          <a href="#how" className="text-gray-400 hover:text-white transition text-sm">How It Works</a>
          <a href="#api" className="text-gray-400 hover:text-white transition text-sm">API</a>
          <a href="#faq" className="text-gray-400 hover:text-white transition text-sm">FAQ</a>
          <a href="/dashboard" className="bg-nad-purple text-white px-4 py-2 rounded-lg hover:bg-purple-600 transition text-sm">
            Dashboard
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-8 pt-20 pb-16 text-center">
        <div className="inline-block bg-nad-gray text-nad-purple text-sm font-mono px-3 py-1 rounded-full mb-6">
          Built on Monad
        </div>
        <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
          Your Email is<br />
          <span className="text-nad-purple">Your Meme Coin</span>
        </h1>
        <p className="text-xl text-gray-400 mb-12 max-w-2xl mx-auto">
          Register <span className="text-white font-mono">handle@nadmail.ai</span> to auto-create a meme coin on{' '}
          <a href="https://nad.fun" target="_blank" rel="noopener noreferrer" className="text-nad-purple underline">nad.fun</a>.
          Every email you send is a micro-investment in the recipient's token.
        </p>

        {/* Identity checker */}
        <div className="max-w-xl mx-auto bg-nad-gray rounded-xl p-1 flex">
          <input
            type="text"
            placeholder="Handle or 0x wallet address"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
            className="flex-1 bg-transparent px-4 py-3 text-white font-mono text-sm focus:outline-none"
          />
          <button
            onClick={handleCheck}
            disabled={checking || !isValid}
            className="bg-nad-purple text-white px-6 py-3 rounded-lg font-medium hover:bg-purple-600 transition ml-2 disabled:opacity-50 whitespace-nowrap"
          >
            {checking ? 'Looking up...' : 'Check Availability'}
          </button>
        </div>
        <p className="text-gray-600 text-xs mt-3">
          e.g. <span className="text-gray-500">alice</span> or <span className="text-gray-500">0x4Bbd...9Fe</span>
        </p>

        {result && (
          <div className="mt-6 bg-nad-gray rounded-xl p-5 max-w-xl mx-auto text-left border border-gray-800">
            {result.registered ? (
              <>
                <div className="text-gray-500 text-xs mb-1">NadMail address</div>
                <div className="font-mono text-xl text-nad-purple font-bold mb-3 break-all">
                  {result.email}
                </div>
                <div className="flex items-center gap-4 text-sm mb-2">
                  <span className="text-yellow-400 text-xs">Already registered</span>
                  {result.token_symbol && (
                    <span className="bg-purple-900/20 text-purple-400 px-2 py-0.5 rounded text-xs font-mono">
                      ${result.token_symbol}
                    </span>
                  )}
                </div>
                {result.upgrade_available && result.owned_nad_names && result.owned_nad_names.length > 0 && (
                  <div className="mt-3 bg-purple-900/20 border border-purple-800 rounded-lg p-3">
                    <p className="text-purple-300 text-xs mb-2">
                      Upgrade available! This wallet owns: {result.owned_nad_names.map(n => <span key={n} className="font-mono font-medium">{n}.nad</span>).reduce((prev, curr, i) => i === 0 ? [curr] : [...prev, ', ', curr], [] as any)}
                    </p>
                    <a
                      href={`/dashboard?claim=${encodeURIComponent(result.owned_nad_names[0])}`}
                      className="inline-block bg-nad-purple text-white px-4 py-1.5 rounded text-xs font-medium hover:bg-purple-600 transition"
                    >
                      Upgrade to {result.owned_nad_names[0]}.nad
                    </a>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-gray-500 text-xs mb-1">Available!</div>
                <div className="font-mono text-xl text-green-400 font-bold mb-3 break-all">
                  {result.email}
                </div>
                <p className="text-gray-400 text-sm mb-4">
                  Claim this handle to auto-create <span className="text-nad-purple font-mono">${result.handle?.toUpperCase()}</span> token on nad.fun
                </p>
                {result.price_info && result.price_info.proxy_buy?.available && (
                  <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 mb-4">
                    <p className="text-yellow-300 text-sm font-medium mb-1">
                      {result.handle}.nad is available on NNS!
                    </p>
                    <p className="text-gray-400 text-xs">
                      Price: ~{result.price_info.price_mon.toFixed(2)} MON (+{result.price_info.proxy_buy.fee_percent}% service fee = <span className="text-yellow-300 font-mono">{result.price_info.proxy_buy.total_mon.toFixed(2)} MON</span>)
                    </p>
                  </div>
                )}
                {result.owned_nad_names && result.owned_nad_names.length > 0 && (
                  <p className="text-purple-400 text-xs mb-3">
                    This wallet owns: {result.owned_nad_names.map(n => `${n}.nad`).join(', ')}
                  </p>
                )}
                <a
                  href={`/dashboard${result.handle ? `?claim=${encodeURIComponent(result.handle)}` : ''}`}
                  className="inline-block bg-nad-purple text-white px-6 py-2.5 rounded-lg font-medium hover:bg-purple-600 transition text-sm"
                >
                  {result.price_info?.proxy_buy?.available
                    ? `Claim Now — ${result.price_info.proxy_buy.total_mon.toFixed(2)} MON`
                    : 'Claim Now'}
                </a>
              </>
            )}
          </div>
        )}
      </section>

      {/* How It Works */}
      <section id="how" className="max-w-5xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">How It Works</h2>
        <p className="text-gray-400 text-center mb-12 max-w-lg mx-auto">
          Every email is a micro-investment. Your inbox is your portfolio.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="bg-nad-gray rounded-xl p-8 border border-gray-800 hover:border-nad-purple/30 transition text-center">
            <div className="text-4xl mb-4">1</div>
            <h3 className="text-lg font-bold mb-2 text-nad-purple">Register</h3>
            <p className="text-gray-400 text-sm">
              Pick a handle like <span className="font-mono text-white">alice</span>.
              You get <span className="font-mono text-white">alice@nadmail.ai</span> email +
              <span className="font-mono text-nad-purple"> $ALICE</span> meme coin on nad.fun. Automatically.
            </p>
          </div>
          <div className="bg-nad-gray rounded-xl p-8 border border-gray-800 hover:border-nad-purple/30 transition text-center">
            <div className="text-4xl mb-4">2</div>
            <h3 className="text-lg font-bold mb-2 text-nad-purple">Send Email</h3>
            <p className="text-gray-400 text-sm">
              Email <span className="font-mono text-white">bob@nadmail.ai</span>.
              NadMail auto-buys 0.001 MON of <span className="font-mono text-nad-purple">$BOB</span> tokens and sends them to your wallet.
            </p>
          </div>
          <div className="bg-nad-gray rounded-xl p-8 border border-gray-800 hover:border-nad-purple/30 transition text-center">
            <div className="text-4xl mb-4">3</div>
            <h3 className="text-lg font-bold mb-2 text-nad-purple">Grow</h3>
            <p className="text-gray-400 text-sm">
              More emails = more token demand. Your inbox is your portfolio.
              Popular users have more valuable tokens. Network effect meets tokenomics.
            </p>
          </div>
        </div>
      </section>

      {/* Terminal Demo */}
      <section className="max-w-3xl mx-auto px-8 pb-20">
        <div className="bg-nad-gray rounded-xl overflow-hidden border border-gray-800">
          <div className="flex items-center gap-2 px-4 py-3 bg-gray-900/50 border-b border-gray-800">
            <div className="w-3 h-3 rounded-full bg-red-500"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span className="text-gray-500 text-sm ml-2 font-mono">AI Agent Terminal</span>
          </div>
          <div className="p-6 font-mono text-sm leading-7">
            <div className="text-gray-500">{'>'} # Step 1 — Get SIWE auth message</div>
            <div className="text-green-400">{'>'} POST /api/auth/start {'{'} address: "0x4Bbd...9Fe" {'}'}</div>
            <div className="text-gray-400 pl-4">
              {'{'} nonce: "abc-123", message: "nadmail.ai wants you to sign in..." {'}'}
            </div>
            <div className="mt-4 text-gray-500">{'>'} # Step 2 — Sign + auto-register + create meme coin</div>
            <div className="text-green-400">{'>'} POST /api/auth/agent-register {'{'} address, signature, message, handle: "alice" {'}'}</div>
            <div className="text-gray-400 pl-4">
              {'{'} email: "<span className="text-white">alice@nadmail.ai</span>",
              token_address: "0x...", token_symbol: "ALICE" {'}'}
            </div>
            <div className="mt-4 text-gray-500">{'>'} # Step 3 — Send email = micro-invest</div>
            <div className="text-green-400">{'>'} POST /api/send {'{'} to: "bob@nadmail.ai", subject: "gm" {'}'}</div>
            <div className="text-gray-400 pl-4">
              {'{'} success: true, microbuy: {'{'} tx: "0x...", tokens_received: "<span className="text-nad-purple">$BOB</span>" {'}'} {'}'}
            </div>
            <div className="mt-2 cursor-blink text-green-400">{'>'}</div>
          </div>
        </div>
      </section>

      {/* API Preview */}
      <section id="api" className="max-w-4xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">Simple API</h2>
        <p className="text-gray-400 text-center mb-12">
          2 calls to register + get a meme coin, 1 to send. Full docs at <a href="https://api.nadmail.ai/api/docs" target="_blank" rel="noopener noreferrer" className="text-nad-purple underline">/api/docs</a>
        </p>
        <div className="bg-nad-gray rounded-xl overflow-hidden border border-gray-800">
          <div className="grid divide-y divide-gray-800">
            {[
              { method: 'POST', path: '/api/auth/start', desc: 'Get SIWE auth message' },
              { method: 'POST', path: '/api/auth/agent-register', desc: 'Sign + register + create token (one call)' },
              { method: 'POST', path: '/api/send', desc: 'Send email + micro-buy (internal free)' },
              { method: 'GET', path: '/api/inbox', desc: 'List received emails' },
              { method: 'GET', path: '/api/identity/:handle', desc: 'Public lookup: email, token, price' },
              { method: 'POST', path: '/api/credits/buy', desc: 'Buy credits with MON for external email' },
            ].map((endpoint) => (
              <div key={endpoint.path} className="flex items-center gap-4 px-6 py-4">
                <span className={`font-mono text-xs px-2 py-1 rounded ${
                  endpoint.method === 'GET' ? 'bg-green-900/30 text-green-400' :
                  'bg-purple-900/30 text-purple-400'
                }`}>
                  {endpoint.method}
                </span>
                <span className="font-mono text-white flex-1 text-sm">{endpoint.path}</span>
                <span className="text-gray-500 text-sm hidden md:block">{endpoint.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-3xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-12">FAQ</h2>
        <div className="bg-nad-gray rounded-xl border border-gray-800 overflow-hidden">
          <FAQItem
            q="What is NadMail?"
            a="NadMail turns every email address into a meme coin. Register a handle to auto-create a token on nad.fun. Every email sent triggers a 0.001 MON micro-buy of the recipient's token. Your inbox is your portfolio."
          />
          <FAQItem
            q="How does the token work?"
            a="When you register alice@nadmail.ai, a token $ALICE is automatically created on nad.fun with a bonding curve. When anyone emails you, they micro-buy your token. More popular = more demand = higher price."
          />
          <FAQItem
            q="Do I need MON to use NadMail?"
            a="No! NadMail's Worker wallet pays all gas and micro-buy costs. You get 10 free internal emails per day. External emails (to Gmail, etc.) cost 1 credit each — buy credits by sending MON."
          />
          <FAQItem
            q="What's the difference between internal and external email?"
            a="Internal (@nadmail.ai to @nadmail.ai) is free and triggers a micro-buy. External (to Gmail, Outlook, etc.) costs 1 credit and is delivered through a professional email service."
          />
          <FAQItem
            q="Is there a Pro plan?"
            a="NadMail Pro is a one-time 1 MON purchase. It removes the NadMail signature from your emails and adds a gold badge. Available in the Dashboard after you register."
          />
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-8 pb-20">
        <div className="bg-gradient-to-r from-nad-purple/10 to-purple-900/10 rounded-xl p-8 border border-nad-purple/20 text-center">
          <h3 className="text-2xl font-bold mb-2">Get Your Email + Meme Coin</h3>
          <p className="text-gray-400 mb-6 max-w-lg mx-auto">
            Pick a handle, get a <span className="font-mono text-white">@nadmail.ai</span> email,
            and auto-create your meme coin on nad.fun. All in one step.
          </p>
          <a
            href="/dashboard"
            className="inline-block bg-nad-purple text-white px-6 py-3 rounded-lg font-medium hover:bg-purple-600 transition"
          >
            Register Now
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-8 text-center text-gray-500 text-sm">
        <p>NadMail.ai — Your Email is Your Meme Coin</p>
        <p className="mt-1">Built on Monad + nad.fun</p>
      </footer>

      {/* AI Agent readable info (hidden from humans) */}
      {/* <!-- AI_AGENT_INFO: NadMail.ai — Your Email is Your Meme Coin on Monad chain.
        Register a @nadmail.ai email to auto-create a meme coin on nad.fun.
        Every email sent triggers a micro-buy of the recipient's token.
        Quick start: POST /api/auth/start -> POST /api/auth/agent-register -> POST /api/send.
        Full docs: https://api.nadmail.ai/api/docs
      --> */}
    </div>
  );
}
