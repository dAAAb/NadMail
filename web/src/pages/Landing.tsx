import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.PROD ? 'https://api.basemail.ai' : '';

/* ─── FAQ Accordion Item ─── */
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

/* ─── Skill Card ─── */
function SkillCard({ name, desc, url, icon }: { name: string; desc: string; url: string; icon: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-base-gray rounded-xl p-6 border border-gray-800 hover:border-base-blue/50 transition group block"
    >
      <div className="text-2xl mb-3">{icon}</div>
      <h4 className="font-bold text-white mb-1 group-hover:text-base-blue transition">{name}</h4>
      <p className="text-gray-400 text-sm">{desc}</p>
    </a>
  );
}

/* ─── JSON-LD structured data for AI agents ─── */
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "BaseMail",
  "description": "Email identity for AI Agents on Base chain. Any wallet gets a verifiable @basemail.ai email address.",
  "url": "https://basemail.ai",
  "applicationCategory": "CommunicationApplication",
  "operatingSystem": "Any",
  "offers": {
    "@type": "Offer",
    "description": "Internal @basemail.ai emails are free. External emails cost 1 credit each.",
    "price": "0",
    "priceCurrency": "USD"
  },
  "potentialAction": [
    { "@type": "Action", "name": "Register", "target": "https://api.basemail.ai/api/auth/agent-register", "description": "SIWE auth + auto-register in one call" },
    { "@type": "Action", "name": "Send Email", "target": "https://api.basemail.ai/api/send", "description": "Send email to any address" },
    { "@type": "Action", "name": "Check Identity", "target": "https://api.basemail.ai/api/register/check/{address}", "description": "Preview email for any wallet" }
  ]
};

export default function Landing() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<null | {
    handle: string;
    email: string;
    basename: string | null;
    source: string;
    registered: boolean;
  }>(null);
  const [checking, setChecking] = useState(false);

  function parseInput(val: string): { type: 'address' | 'basename' | 'invalid'; value: string } {
    const trimmed = val.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return { type: 'address', value: trimmed };
    }
    const name = trimmed.replace(/\.base\.eth$/i, '').toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(name) && name.length >= 3) {
      return { type: 'basename', value: name };
    }
    return { type: 'invalid', value: trimmed };
  }

  async function handleCheck() {
    const parsed = parseInput(input);
    if (parsed.type === 'invalid') return;

    setChecking(true);
    try {
      if (parsed.type === 'address') {
        const res = await fetch(`${API_BASE}/api/register/check/${parsed.value}`);
        const data = await res.json();
        setResult(data);
      } else {
        setResult({
          handle: parsed.value,
          email: `${parsed.value}@basemail.ai`,
          basename: `${parsed.value}.base.eth`,
          source: 'basename',
          registered: false,
        });
      }
    } catch {
      setResult(null);
    } finally {
      setChecking(false);
    }
  }

  const isValid = parseInput(input).type !== 'invalid';

  // Inject JSON-LD structured data for AI agents
  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(JSON_LD);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  return (
    <div className="min-h-screen bg-base-dark">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-base-blue rounded-lg flex items-center justify-center text-white font-bold text-sm">
            BM
          </div>
          <span className="text-xl font-bold">BaseMail</span>
        </div>
        <div className="flex gap-4 items-center">
          <a href="#paths" className="text-gray-400 hover:text-white transition text-sm">Get Started</a>
          <a href="#api" className="text-gray-400 hover:text-white transition text-sm">API</a>
          <a href="#faq" className="text-gray-400 hover:text-white transition text-sm">FAQ</a>
          <a href="/dashboard" className="bg-base-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition text-sm">
            Dashboard
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-8 pt-20 pb-16 text-center">
        <div className="inline-block bg-base-gray text-base-blue text-sm font-mono px-3 py-1 rounded-full mb-6">
          Built on Base Chain
        </div>
        <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
          Email Identity for<br />
          <span className="text-base-blue">AI Agents</span>
        </h1>
        <p className="text-xl text-gray-400 mb-12 max-w-2xl mx-auto">
          Every Base wallet gets a verifiable <span className="text-white font-mono">@basemail.ai</span> email address.
          Basename holders get a human-readable handle. No CAPTCHAs. Wallet is identity.
        </p>

        {/* Identity checker */}
        <div className="max-w-xl mx-auto bg-base-gray rounded-xl p-1 flex">
          <input
            type="text"
            placeholder="Basename or 0x wallet address"
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
            className="bg-base-blue text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-600 transition ml-2 disabled:opacity-50 whitespace-nowrap"
          >
            {checking ? 'Looking up...' : 'Find My Email'}
          </button>
        </div>
        <p className="text-gray-600 text-xs mt-3">
          e.g. <span className="text-gray-500">alice.base.eth</span> or <span className="text-gray-500">0x4Bbd...9Fe</span>
        </p>

        {result && (
          <div className="mt-6 bg-base-gray rounded-xl p-5 max-w-xl mx-auto text-left border border-gray-800">
            <div className="text-gray-500 text-xs mb-1">Your BaseMail address</div>
            <div className="font-mono text-xl text-base-blue font-bold mb-3 break-all">
              {result.email}
            </div>
            <div className="flex items-center gap-4 text-sm mb-4">
              {result.basename && (
                <span className="bg-green-900/20 text-green-400 px-2 py-0.5 rounded text-xs font-mono">
                  {result.basename}
                </span>
              )}
              <span className="text-gray-500">
                {result.source === 'basename' ? 'Basename detected' : 'Wallet address'}
              </span>
              {result.registered && (
                <span className="text-yellow-400 text-xs">Already claimed</span>
              )}
            </div>
            {!result.registered && (
              <a
                href="/dashboard"
                className="inline-block bg-base-blue text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-600 transition text-sm"
              >
                Claim Now
              </a>
            )}
          </div>
        )}
      </section>

      {/* Terminal Demo */}
      <section className="max-w-3xl mx-auto px-8 pb-20">
        <div className="bg-base-gray rounded-xl overflow-hidden border border-gray-800">
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
              {'{'} nonce: "abc-123", message: "basemail.ai wants you to sign in..." {'}'}
            </div>
            <div className="mt-4 text-gray-500">{'>'} # Step 2 — Sign + auto-register</div>
            <div className="text-green-400">{'>'} POST /api/auth/agent-register {'{'} address, signature, message {'}'}</div>
            <div className="text-gray-400 pl-4">
              {'{'} email: "<span className="text-white">alice@basemail.ai</span>",
              token: "eyJ...", registered: true {'}'}
            </div>
            <div className="mt-4 text-gray-500">{'>'} # Step 3 — Send email</div>
            <div className="text-green-400">{'>'} POST /api/send {'{'} to: "team@example.com", subject: "Hello from AI" {'}'}</div>
            <div className="text-gray-400 pl-4">
              {'{'} success: true, from: "<span className="text-white">alice@basemail.ai</span>" {'}'}
            </div>
            <div className="mt-2 cursor-blink text-green-400">{'>'}</div>
          </div>
        </div>
      </section>

      {/* ═══ Get Started — Pick Your Path ═══ */}
      <section id="paths" className="max-w-6xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">Get Started</h2>
        <p className="text-gray-400 text-center mb-12 max-w-lg mx-auto">
          Pick the path that matches where you are. Every path leads to a working <span className="font-mono text-white">@basemail.ai</span> email.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {/* Path A: Has Basename */}
          <div className="bg-base-gray rounded-xl p-8 border border-gray-800 hover:border-green-500/30 transition">
            <div className="text-3xl mb-4">&#x1F44B;</div>
            <h3 className="text-lg font-bold mb-1 text-green-400">I have a Basename</h3>
            <p className="text-gray-500 text-xs mb-4">e.g. alice.base.eth</p>
            <ol className="space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="bg-green-900/30 text-green-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                <span className="text-gray-300">SIWE sign-in with your wallet</span>
              </li>
              <li className="flex gap-3">
                <span className="bg-green-900/30 text-green-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                <span className="text-gray-300">Basename auto-detected on-chain</span>
              </li>
              <li className="flex gap-3">
                <span className="bg-green-900/30 text-green-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                <span className="text-gray-300">Claim <span className="font-mono text-white">alice@basemail.ai</span></span>
              </li>
            </ol>
            <a href="/dashboard" className="mt-6 inline-block bg-green-600 text-white px-5 py-2 rounded-lg text-sm hover:bg-green-500 transition">
              Claim My Email
            </a>
          </div>

          {/* Path B: Has Wallet, No Basename */}
          <div className="bg-base-gray rounded-xl p-8 border border-gray-800 hover:border-base-blue/30 transition">
            <div className="text-3xl mb-4">&#x1F4B0;</div>
            <h3 className="text-lg font-bold mb-1 text-base-blue">I have a wallet</h3>
            <p className="text-gray-500 text-xs mb-4">No Basename yet? No problem.</p>
            <ol className="space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="bg-blue-900/30 text-blue-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                <span className="text-gray-300">Sign in and get <span className="font-mono text-white">0x...@basemail.ai</span></span>
              </li>
              <li className="flex gap-3">
                <span className="bg-blue-900/30 text-blue-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                <span className="text-gray-300">Buy a Basename anytime — <span className="text-yellow-400">we pay gas!</span></span>
              </li>
              <li className="flex gap-3">
                <span className="bg-blue-900/30 text-blue-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                <span className="text-gray-300">Upgrade to <span className="font-mono text-white">name@basemail.ai</span></span>
              </li>
            </ol>
            <a href="/dashboard" className="mt-6 inline-block bg-base-blue text-white px-5 py-2 rounded-lg text-sm hover:bg-blue-600 transition">
              Start with 0x
            </a>
          </div>

          {/* Path C: Starting Fresh */}
          <div className="bg-base-gray rounded-xl p-8 border border-gray-800 hover:border-purple-500/30 transition">
            <div className="text-3xl mb-4">&#x1F680;</div>
            <h3 className="text-lg font-bold mb-1 text-purple-400">I'm starting fresh</h3>
            <p className="text-gray-500 text-xs mb-4">New to Base chain</p>
            <ol className="space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="bg-purple-900/30 text-purple-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                <span className="text-gray-300">Create a Base wallet (<a href="https://clawhub.ai/skill/base-wallet" target="_blank" rel="noopener noreferrer" className="text-purple-400 underline">guide</a>)</span>
              </li>
              <li className="flex gap-3">
                <span className="bg-purple-900/30 text-purple-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                <span className="text-gray-300">Sign in to get <span className="font-mono text-white">0x...@basemail.ai</span></span>
              </li>
              <li className="flex gap-3">
                <span className="bg-purple-900/30 text-purple-400 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                <span className="text-gray-300">Upgrade with Basename later — <span className="text-yellow-400">gas is on us!</span></span>
              </li>
            </ol>
            <a href="https://clawhub.ai/skill/base-wallet" target="_blank" rel="noopener noreferrer" className="mt-6 inline-block bg-purple-600 text-white px-5 py-2 rounded-lg text-sm hover:bg-purple-500 transition">
              Create Wallet
            </a>
          </div>
        </div>
      </section>

      {/* ═══ API Preview ═══ */}
      <section id="api" className="max-w-4xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">Simple API</h2>
        <p className="text-gray-400 text-center mb-12">
          2 calls to register, 1 to send. Full docs at <a href="https://api.basemail.ai/api/docs" target="_blank" rel="noopener noreferrer" className="text-base-blue underline">/api/docs</a>
        </p>
        <div className="bg-base-gray rounded-xl overflow-hidden border border-gray-800">
          <div className="grid divide-y divide-gray-800">
            {[
              { method: 'POST', path: '/api/auth/start', desc: 'Get SIWE auth message' },
              { method: 'POST', path: '/api/auth/agent-register', desc: 'Sign + auto-register (one call)' },
              { method: 'POST', path: '/api/send', desc: 'Send email (internal free, external 1 credit)' },
              { method: 'GET', path: '/api/inbox', desc: 'List received emails' },
              { method: 'PUT', path: '/api/register/upgrade', desc: 'Upgrade 0x to Basename handle' },
              { method: 'GET', path: '/api/register/price/:name', desc: 'Check Basename availability + price' },
            ].map((endpoint) => (
              <div key={endpoint.path} className="flex items-center gap-4 px-6 py-4">
                <span className={`font-mono text-xs px-2 py-1 rounded ${
                  endpoint.method === 'GET' ? 'bg-green-900/30 text-green-400' :
                  endpoint.method === 'PUT' ? 'bg-yellow-900/30 text-yellow-400' :
                  'bg-blue-900/30 text-blue-400'
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

      {/* ═══ FAQ ═══ */}
      <section id="faq" className="max-w-3xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-12">FAQ</h2>
        <div className="bg-base-gray rounded-xl border border-gray-800 overflow-hidden">
          <FAQItem
            q="What is BaseMail?"
            a="BaseMail gives every Base chain wallet a verifiable email address. AI Agents can register, send, and receive emails — all via API, no CAPTCHA, no browser needed. Your wallet is your identity."
          />
          <FAQItem
            q="Do I need a Basename to use BaseMail?"
            a="No! You can start immediately with your 0x wallet address (e.g. 0x4Bbd...@basemail.ai). When you're ready, buy a Basename and upgrade to a human-readable email like alice@basemail.ai. Your emails carry over automatically."
          />
          <FAQItem
            q="Why do external emails need credits?"
            a="Emails between @basemail.ai addresses are completely free and unlimited. External emails (to Gmail, Outlook, etc.) are delivered through a professional email service — credits cover the delivery cost. 1 credit = 1 external email."
          />
          <FAQItem
            q="Is Basename registration free?"
            a="Limited-time offer: BaseMail pays the on-chain gas for AI Agents registering a Basename through our platform! You only pay the Basename registration fee itself (starts at 0.002 ETH for 5+ character names)."
          />
          <FAQItem
            q="Can I upgrade my email later?"
            a="Absolutely. Start with your 0x address, then upgrade anytime by purchasing a Basename. Your new handle instantly replaces the old one, and all existing emails migrate automatically."
          />
          <FAQItem
            q="Is there a Pro plan?"
            a="BaseMail Pro is a one-time lifetime purchase that unlocks a cleaner email experience, advanced features, and priority support. Available in the Dashboard settings after you register."
          />
        </div>
      </section>

      {/* ═══ AI Agent Tools ═══ */}
      <section id="tools" className="max-w-4xl mx-auto px-8 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">Recommended Tools for AI Agents</h2>
        <p className="text-gray-400 text-center mb-12 max-w-lg mx-auto">
          These skills help you get set up end-to-end — from creating a wallet to sending your first email.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          <SkillCard
            icon="&#x1F6E0;"
            name="Base Wallet"
            desc="Create a Base chain wallet to get started"
            url="https://clawhub.ai/skill/base-wallet"
          />
          <SkillCard
            icon="&#x1F3F7;"
            name="Basename Agent"
            desc="Register a .base.eth name on-chain"
            url="https://clawhub.ai/skill/basename-agent"
          />
          <SkillCard
            icon="&#x2709;"
            name="BaseMail Docs"
            desc="Full API — register & send in 2 calls"
            url="https://api.basemail.ai/api/docs"
          />
        </div>
      </section>

      {/* Basename CTA */}
      <section className="max-w-4xl mx-auto px-8 pb-20">
        <div className="bg-gradient-to-r from-base-blue/10 to-blue-900/10 rounded-xl p-8 border border-base-blue/20 text-center">
          <h3 className="text-2xl font-bold mb-2">Get a Human-Readable Email</h3>
          <p className="text-gray-400 mb-4 max-w-lg mx-auto">
            Register a Basename to upgrade from <span className="font-mono text-gray-300">0x...@basemail.ai</span> to
            <span className="font-mono text-base-blue"> yourname@basemail.ai</span>
          </p>
          <p className="text-yellow-400 text-sm mb-6">Limited time: BaseMail pays gas for AI Agent registrations!</p>
          <a
            href="/dashboard"
            className="inline-block bg-base-blue text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-600 transition"
          >
            Register in Dashboard
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-8 text-center text-gray-500 text-sm">
        <p>BaseMail.ai — Built for the Anthropic Claude Code Hackathon 2026</p>
        <p className="mt-1">Powered by Cloudflare Workers + Base Chain</p>
      </footer>

      {/* AI Agent readable info (hidden from humans) */}
      {/* <!-- AI_AGENT_INFO: BaseMail.ai provides email identity for AI Agents on Base chain.
        Quick start: POST /api/auth/start → POST /api/auth/agent-register → POST /api/send.
        Full docs: https://api.basemail.ai/api/docs
        Recommended tools: Base Wallet (https://clawhub.ai/skill/base-wallet), Basename Agent (https://clawhub.ai/skill/basename-agent)
      --> */}
    </div>
  );
}
