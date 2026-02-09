#!/usr/bin/env node
/**
 * NadMail Setup Script
 * Creates a new wallet for AI agents who don't have one
 *
 * Usage:
 *   node setup.js              # Show help
 *   node setup.js --managed    # Generate wallet (encrypted by default)
 *   node setup.js --managed --no-encrypt  # Generate without encryption
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const CONFIG_DIR = path.join(process.env.HOME, '.nadmail');
const KEY_FILE = path.join(CONFIG_DIR, 'private-key');
const KEY_FILE_ENCRYPTED = path.join(CONFIG_DIR, 'private-key.enc');
const WALLET_FILE = path.join(CONFIG_DIR, 'wallet.json');
const MNEMONIC_FILE = path.join(CONFIG_DIR, 'mnemonic.backup');
const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.log');

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

function promptPassword(question) {
  return prompt(question);
}

function logAudit(action, details = {}) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) return;
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      wallet: details.wallet ? `${details.wallet.slice(0, 6)}...${details.wallet.slice(-4)}` : null,
      success: details.success ?? true,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    // Silently ignore audit errors
  }
}

function encryptPrivateKey(privateKey, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    algorithm: 'aes-256-gcm',
  };
}

function showHelp() {
  console.log('NadMail Wallet Setup');
  console.log('========================\n');

  console.log('Recommended: Use an environment variable (no setup script needed)\n');
  console.log('   export NADMAIL_PRIVATE_KEY="0xYourPrivateKey"');
  console.log('   node scripts/register.js\n');

  console.log('Or specify an existing wallet path:\n');
  console.log('   node scripts/register.js --wallet /path/to/your/private-key\n');

  console.log('-'.repeat(50));
  console.log('\nIf you don\'t have a wallet, let this skill generate one:\n');
  console.log('   node setup.js --managed\n');
  console.log('   Encrypted by default. Private key stored at ~/.nadmail/private-key.enc');
  console.log('   Only recommended if you don\'t already have a wallet.\n');

  console.log('Unencrypted option (less secure):\n');
  console.log('   node setup.js --managed --no-encrypt\n');
  console.log('   Private key stored in plaintext. Only use in trusted environments.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const isManaged = args.includes('--managed');
  const noEncrypt = args.includes('--no-encrypt');
  const isEncrypt = !noEncrypt;

  if (!isManaged) {
    showHelp();
    process.exit(0);
  }

  console.log('NadMail Wallet Setup (Managed Mode)');
  console.log('=======================================\n');

  console.log('Warning: About to generate a new wallet.');
  if (isEncrypt) {
    console.log('   Private key will be encrypted and stored at ~/.nadmail/\n');
  } else {
    console.log('   Private key will be stored in PLAINTEXT at ~/.nadmail/');
    console.log('   Make sure only you have access to this machine.');
    console.log('   Consider using encrypted mode instead (remove --no-encrypt).\n');
  }

  // Check if wallet already exists
  if (fs.existsSync(KEY_FILE) || fs.existsSync(KEY_FILE_ENCRYPTED)) {
    console.log('Wallet already exists!');
    if (fs.existsSync(KEY_FILE)) console.log(`   ${KEY_FILE}`);
    if (fs.existsSync(KEY_FILE_ENCRYPTED)) console.log(`   ${KEY_FILE_ENCRYPTED}`);

    const answer = await prompt('\nOverwrite existing wallet? This will permanently delete the old one! (yes/no): ');
    if (answer.toLowerCase() !== 'yes') {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  const confirm = await prompt('Continue? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    process.exit(0);
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    console.log(`\nCreated directory ${CONFIG_DIR}`);
  }

  console.log('\nGenerating new wallet...\n');
  const wallet = ethers.Wallet.createRandom();

  console.log('='.repeat(50));
  console.log('New wallet created');
  console.log('='.repeat(50));
  console.log(`\nAddress: ${wallet.address}`);

  if (isEncrypt) {
    const password = await promptPassword('\nSet encryption password: ');
    const confirmPwd = await promptPassword('Confirm password: ');

    if (password !== confirmPwd) {
      console.error('Passwords do not match. Cancelled.');
      process.exit(1);
    }

    if (password.length < 8) {
      console.error('Password must be at least 8 characters.');
      process.exit(1);
    }

    const encryptedData = encryptPrivateKey(wallet.privateKey, password);
    fs.writeFileSync(KEY_FILE_ENCRYPTED, JSON.stringify(encryptedData, null, 2), { mode: 0o600 });
    console.log(`\nEncrypted key saved to: ${KEY_FILE_ENCRYPTED}`);

    if (fs.existsSync(KEY_FILE)) {
      fs.unlinkSync(KEY_FILE);
    }
  } else {
    fs.writeFileSync(KEY_FILE, wallet.privateKey, { mode: 0o600 });
    console.log(`\nPrivate key saved to: ${KEY_FILE}`);

    if (fs.existsSync(KEY_FILE_ENCRYPTED)) {
      fs.unlinkSync(KEY_FILE_ENCRYPTED);
    }
  }

  // Display mnemonic for manual backup
  console.log('\n' + '='.repeat(50));
  console.log('IMPORTANT: Back up your mnemonic phrase now!');
  console.log('='.repeat(50));
  console.log('\n' + wallet.mnemonic.phrase + '\n');
  console.log('='.repeat(50));
  console.log('This is shown only once! Write it down or store it safely.');
  console.log('Losing your mnemonic means losing access to your wallet.');
  console.log('='.repeat(50));

  const saveMnemonic = await prompt('\nSave mnemonic to file? (yes/no, default no): ');
  if (saveMnemonic.toLowerCase() === 'yes') {
    fs.writeFileSync(MNEMONIC_FILE, wallet.mnemonic.phrase, { mode: 0o400 });
    console.log(`Mnemonic saved to: ${MNEMONIC_FILE} (read-only)`);
    console.log('Consider deleting this file after backing it up elsewhere.');
  } else {
    console.log('Mnemonic not saved to file. Make sure you backed it up manually.');
  }

  const walletInfo = {
    address: wallet.address,
    created_at: new Date().toISOString(),
    encrypted: isEncrypt,
    note: 'Private key stored separately',
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletInfo, null, 2), { mode: 0o600 });
  logAudit('wallet_created', { wallet: wallet.address, success: true });

  console.log('\n' + '='.repeat(50));
  console.log('\nSecurity reminders:');
  console.log('   1. Back up your mnemonic to a safe location');
  console.log('   2. Delete the mnemonic file after backing up');
  console.log('   3. Never share your private key or mnemonic');
  if (isEncrypt) {
    console.log('   4. Remember your encryption password — it cannot be recovered');
  }

  console.log('\nNext steps:');
  console.log('   node scripts/register.js');
  console.log('   (Optional) Get a .nad domain for a prettier email address');

  console.log('\nSetup complete!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
