import { generateNonce, consumeNonce, createSiweMessage, verifySiweSignature } from '../src/auth/siwe.mjs';
import { privateKeyToAccount } from 'viem/accounts';

async function main() {
  console.log('Testing EIP-4361 Sign-In With Ethereum (SIWE) Authentication (BLK-02)...');

  // Test 1: Nonce Generation
  const nonce = generateNonce();
  if (!nonce || nonce.length !== 32) {
    throw new Error('SIWE nonce generation failed');
  }
  console.log('✔ Nonce generated successfully:', nonce);

  // Test 2: SIWE Message Formatting
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const message = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: account.address,
    statement: 'Sign in to Patronage Digital Art Marketplace.',
    uri: 'http://127.0.0.1:8787',
    nonce,
    issuedAt: new Date().toISOString(),
  });

  if (!message.includes(account.address) || !message.includes(nonce)) {
    throw new Error('SIWE message formatting error');
  }
  console.log('✔ EIP-4361 message formatted correctly');

  // Test 3: Message Signing & Cryptographic Signature Verification
  const signature = await account.signMessage({ message });
  const isValid = await verifySiweSignature({ address: account.address, message, signature });

  if (!isValid) {
    throw new Error('SIWE signature verification failed');
  }
  console.log('✔ Cryptographic EIP-4361 signature verified cleanly!');

  // Test 4: Replay Protection & Nonce Consumption
  const isConsumedFirst = consumeNonce(nonce);
  const isConsumedSecond = consumeNonce(nonce);

  if (!isConsumedFirst || isConsumedSecond) {
    throw new Error('Replay attack protection failed: nonce was re-usable');
  }
  console.log('✔ Replay attack protection verified: single-use nonce consumed cleanly');

  console.log('\nBLK-02 EIP-4361 SIWE Wallet Authentication Test Passed Cleanly!');
}

main().catch((err) => {
  console.error('BLK-02 test failed:', err);
  process.exit(1);
});
