#!/usr/bin/env node
/**
 * NadMail Registration Script
 * Registers an AI agent for a @nadmail.ai email address
 *
 * Usage:
 *   node register.js [--handle yourname] [--wallet /path/to/key]
 *
 * Private key sources (in order of priority):
 *   1. NADMAIL_PRIVATE_KEY environment variable (recommended)
 *   2. --wallet argument specifying path to your key file
 *   3. ~/.nadmail/private-key (managed by setup.js)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const API_BASE = 'https://api.nadmail.ai';
const CONFIG_DIR = path.join(process.env.HOME, '.nadmail');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.log');

function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return null;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function logAudit(action, details = {}) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      wallet: details.wallet ? `${details.wallet.slice(0, 6)}...${details.wallet.slice(-4)}` : null,
      success: details.success ?? true,
      error: details.error,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    // Silently ignore audit errors
  }
}

function decryptPrivateKey(encryptedData, password) {
  const key = crypto.scryptSync(password, Buffer.from(encryptedData.salt, 'hex'), 32);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encryptedData.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function getPrivateKey() {
  // 1. Environment variable (highest priority, most secure)
  if (process.env.NADMAIL_PRIVATE_KEY) {
    console.log('Using NADMAIL_PRIVATE_KEY environment variable');
    return process.env.NADMAIL_PRIVATE_KEY.trim();
  }

  // 2. --wallet argument
  const walletArg = getArg('--wallet');
  if (walletArg) {
    const walletPath = walletArg.replace(/^~/, process.env.HOME);
    if (fs.existsSync(walletPath)) {
      console.log(`Using wallet file: ${walletPath}`);
      return fs.readFileSync(walletPath, 'utf8').trim();
    } else {
      console.error(`Wallet file not found: ${walletPath}`);
      process.exit(1);
    }
  }

  // 3. ~/.nadmail managed wallet (encrypted or plaintext)
  const encryptedKeyFile = path.join(CONFIG_DIR, 'private-key.enc');
  const plaintextKeyFile = path.join(CONFIG_DIR, 'private-key');

  if (fs.existsSync(encryptedKeyFile)) {
    console.log(`Found encrypted wallet: ${encryptedKeyFile}`);
    const encryptedData = JSON.parse(fs.readFileSync(encryptedKeyFile, 'utf8'));

    const password = process.env.NADMAIL_PASSWORD || await prompt('Enter wallet password: ');
    try {
      const privateKey = decryptPrivateKey(encryptedData, password);
      logAudit('decrypt_attempt', { success: true });
      return privateKey;
    } catch (e) {
      logAudit('decrypt_attempt', { success: false, error: 'decryption failed' });
      console.error('Wrong password or decryption failed');
      process.exit(1);
    }
  }

  if (fs.existsSync(plaintextKeyFile)) {
    console.log(`Using managed wallet: ${plaintextKeyFile}`);
    return fs.readFileSync(plaintextKeyFile, 'utf8').trim();
  }

  console.error('No wallet found.\n');
  console.error('Options:');
  console.error('  A. export NADMAIL_PRIVATE_KEY="0xYourPrivateKey"');
  console.error('  B. node register.js --wallet /path/to/key');
  console.error('  C. node setup.js --managed (generate new wallet)');
  process.exit(1);
}

async function api(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res.json();
}

async function main() {
  const handle = getArg('--handle');

  console.log('NadMail Registration');
  console.log('========================\n');

  const privateKey = await getPrivateKey();
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;

  console.log(`\nWallet: ${address}`);
  if (handle) console.log(`Handle: ${handle}`);

  // Step 1: Start auth
  console.log('\n1. Starting authentication...');
  const startData = await api('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });

  if (!startData.message) {
    console.error('Auth failed:', startData);
    logAudit('register', { wallet: address, success: false, error: 'auth_start_failed' });
    process.exit(1);
  }
  console.log('   Got SIWE message');

  // Step 2: Sign message
  console.log('\n2. Signing message...');
  const signature = await wallet.signMessage(startData.message);
  console.log('   Message signed');

  // Step 3: Register
  console.log('\n3. Registering agent...');
  const registerData = await api('/api/auth/agent-register', {
    method: 'POST',
    body: JSON.stringify({
      address,
      message: startData.message,
      signature,
      handle: handle || undefined,
    }),
  });

  if (!registerData.token) {
    console.error('Registration failed:', registerData);
    logAudit('register', { wallet: address, success: false, error: 'register_failed' });
    process.exit(1);
  }
  console.log('   Registered!');

  const token = registerData.token;
  const email = registerData.email || `${registerData.handle}@nadmail.ai`;

  // Save token
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const tokenData = {
    token,
    email,
    handle: registerData.handle || handle || null,
    wallet: address.toLowerCase(),
    saved_at: new Date().toISOString(),
    expires_hint: '24h',
  };

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
  logAudit('register', { wallet: address, success: true });

  console.log('\n' + '='.repeat(40));
  console.log('Success!');
  console.log('='.repeat(40));
  console.log(`\nEmail: ${email}`);
  console.log(`Token saved to: ${TOKEN_FILE}`);
  if (registerData.token_address) {
    console.log(`Meme coin: $${registerData.token_symbol} (${registerData.token_address})`);
  }

  console.log('\nNext steps:');
  console.log('  node scripts/send.js someone@nadmail.ai "Hi" "Hello!"');
  console.log('  node scripts/inbox.js');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
