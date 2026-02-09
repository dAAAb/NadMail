#!/usr/bin/env node
/**
 * NadMail Send Email Script
 *
 * Usage: node send.js <to> <subject> <body> [--emo <preset|amount>]
 *
 * Examples:
 *   node send.js alice@nadmail.ai "Hello" "How are you?"
 *   node send.js alice@nadmail.ai "Hello" "Great work!" --emo bullish
 *   node send.js alice@nadmail.ai "Hello" "WAGMI!" --emo 0.1
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.nadmail.ai';
const CONFIG_DIR = path.join(process.env.HOME, '.nadmail');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.log');

// Emo-buy presets (same tiers as the $DIPLOMAT AI agent)
const EMO_PRESETS = {
  friendly: { amount: 0.01,  label: 'Friendly (+0.01 MON)' },
  bullish:  { amount: 0.025, label: 'Bullish (+0.025 MON)' },
  super:    { amount: 0.05,  label: 'Super Bullish (+0.05 MON)' },
  moon:     { amount: 0.075, label: 'Moon (+0.075 MON)' },
  wagmi:    { amount: 0.1,   label: 'WAGMI (+0.1 MON)' },
};

function logAudit(action, details = {}) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) return;
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      to: details.to ? `${details.to.split('@')[0].slice(0, 4)}...@${details.to.split('@')[1]}` : null,
      success: details.success ?? true,
      error: details.error,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    // Silently ignore audit errors
  }
}

function getToken() {
  if (process.env.NADMAIL_TOKEN) {
    return process.env.NADMAIL_TOKEN;
  }

  if (!fs.existsSync(TOKEN_FILE)) {
    console.error('Not registered yet. Run register.js first.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));

  if (data.saved_at) {
    const hoursSinceSaved = (Date.now() - new Date(data.saved_at).getTime()) / 1000 / 60 / 60;
    if (hoursSinceSaved > 20) {
      console.log('Warning: Token may be expiring soon. Run register.js again if you get auth errors.');
    }
  }

  return data.token;
}

function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return null;
}

function parseEmoArg() {
  const emoValue = getArg('--emo');
  if (!emoValue) return 0;

  // Check preset name
  const preset = EMO_PRESETS[emoValue.toLowerCase()];
  if (preset) return preset.amount;

  // Try numeric value
  const num = parseFloat(emoValue);
  if (!isNaN(num) && num >= 0 && num <= 0.1) return num;

  console.error(`Invalid --emo value: "${emoValue}"`);
  console.error('Presets: friendly (0.01), bullish (0.025), super (0.05), moon (0.075), wagmi (0.1)');
  console.error('Or a number between 0 and 0.1');
  process.exit(1);
}

async function main() {
  // Filter out --emo and its value from positional args
  const rawArgs = process.argv.slice(2);
  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--emo') {
      i++; // skip value
      continue;
    }
    positional.push(rawArgs[i]);
  }

  const [to, subject, ...bodyParts] = positional;
  const body = bodyParts.join(' ');

  if (!to || !subject) {
    console.log('NadMail - Send Email\n');
    console.log('Usage: node send.js <to> <subject> <body> [--emo <preset|amount>]\n');
    console.log('Examples:');
    console.log('  node send.js alice@nadmail.ai "Hello" "How are you?"');
    console.log('  node send.js alice@nadmail.ai "Hello" "Great work!" --emo bullish');
    console.log('  node send.js alice@nadmail.ai "Hello" "WAGMI!" --emo 0.1\n');
    console.log('Emo-Buy Presets (extra MON to pump recipient\'s meme coin):');
    for (const [name, preset] of Object.entries(EMO_PRESETS)) {
      console.log(`  --emo ${name.padEnd(10)} ${preset.label} (total: ${(0.001 + preset.amount).toFixed(3)} MON)`);
    }
    console.log('\nNote: Emo-buy only works for @nadmail.ai recipients.');
    console.log('External emails require credits (see: GET /api/credits).');
    process.exit(1);
  }

  const emoAmount = parseEmoArg();
  const isInternal = to.toLowerCase().endsWith('@nadmail.ai');
  const token = getToken();

  // Build request body
  const reqBody = { to, subject, body: body || '' };
  if (emoAmount > 0 && isInternal) {
    reqBody.emo_amount = emoAmount;
  }

  console.log('Sending email...');
  console.log(`  To: ${to}`);
  console.log(`  Subject: ${subject}`);
  if (emoAmount > 0 && isInternal) {
    const presetEntry = Object.entries(EMO_PRESETS).find(([, p]) => p.amount === emoAmount);
    const label = presetEntry ? presetEntry[0] : 'custom';
    console.log(`  Emo-Boost: ${label} (+${emoAmount} MON, total: ${(0.001 + emoAmount).toFixed(3)} MON)`);
  } else if (emoAmount > 0 && !isInternal) {
    console.log('  Note: Emo-buy skipped (only works for @nadmail.ai recipients)');
  }

  try {
    const res = await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(reqBody),
    });

    const data = await res.json();

    if (data.success) {
      console.log('\nSent!');
      console.log(`  From: ${data.from}`);
      console.log(`  Email ID: ${data.email_id}`);

      if (data.microbuy) {
        const mb = data.microbuy;
        if (mb.emo_boost) {
          console.log(`\n  EMO-BOOSTED $${mb.tokenSymbol || mb.token_symbol}!`);
          console.log(`  Total: ${mb.totalMonSpent || mb.total_mon_spent} MON`);
        } else {
          console.log(`\n  Micro-bought $${mb.tokenSymbol || mb.token_symbol}`);
          console.log(`  Amount: 0.001 MON`);
        }
        if (mb.tokensBought || mb.tokens_bought) {
          console.log(`  Tokens received: ${mb.tokensBought || mb.tokens_bought}`);
        }
        if (mb.priceChangePercent || mb.price_change_percent) {
          console.log(`  Price impact: ${mb.priceChangePercent || mb.price_change_percent}%`);
        }
        if (mb.tx) {
          console.log(`  TX: ${mb.tx}`);
        }
      }

      logAudit('send_email', { to, success: true });
    } else {
      console.error('\nFailed:', data.error || JSON.stringify(data));
      if (data.hint) console.error('Hint:', data.hint);
      logAudit('send_email', { to, success: false, error: data.error });
      process.exit(1);
    }
  } catch (err) {
    console.error('\nError:', err.message);
    logAudit('send_email', { to, success: false, error: err.message });
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
