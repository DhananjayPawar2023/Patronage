import '../src/config/load-env.mjs';
import { createStorageProvider, PinataStorageProvider } from '../src/providers/storage.mjs';

async function main() {
  console.log('=== TESTING FAIL-HARD DECENTRALIZED STORAGE IN PRODUCTION MODE ===\n');

  // Set NODE_ENV to production
  process.env.NODE_ENV = 'production';

  // 1. Prove createStorageProvider strictly refuses to start with LocalStorageProvider in production
  console.log('▶ [1/3] Testing factory refusal of LocalStorageProvider in production...');
  delete process.env.STORAGE_PROVIDER; // default / unset
  let startupFailedAsExpected = false;
  try {
    createStorageProvider();
  } catch (err) {
    startupFailedAsExpected = true;
    console.log(`✔ Startup correctly threw error: "${err.message}"`);
  }
  if (!startupFailedAsExpected) {
    throw new Error('Factory allowed LocalStorageProvider in production mode!');
  }

  // 2. Prove PinataStorageProvider aborts when unconfigured in production mode
  console.log('\n▶ [2/3] Testing PinataStorageProvider unconfigured credential abort...');
  const unconfiguredPinata = new PinataStorageProvider(''); // empty JWT
  let pinAbortAsExpected = false;
  try {
    await unconfiguredPinata.put(Buffer.from('test artwork'), 'art.png', 'image/png');
  } catch (err) {
    pinAbortAsExpected = true;
    console.log(`✔ Pinning correctly aborted with error: "${err.message}"`);
  }
  if (!pinAbortAsExpected) {
    throw new Error('PinataStorageProvider silently fell back to local storage in production mode!');
  }

  // 3. Prove PinataStorageProvider aborts pre-transaction when JWT is invalid/rejected by network
  console.log('\n▶ [3/3] Testing PinataStorageProvider network failure fail-hard (invalid JWT)...');
  const invalidPinata = new PinataStorageProvider('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.INVALID_SIGNATURE_KEY');
  let networkAbortAsExpected = false;
  try {
    await invalidPinata.put(Buffer.from('test artwork 2'), 'art2.png', 'image/png');
  } catch (err) {
    networkAbortAsExpected = true;
    console.log(`✔ Network failure correctly aborted: "${err.message}"`);
  }
  if (!networkAbortAsExpected) {
    throw new Error('Invalid JWT was silently accepted or fell back to local disk!');
  }

  console.log('\n====================================================');
  console.log('  SUCCESS: FAIL-HARD STORAGE POLICY 100% PROVEN!');
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Fail-hard storage test failed:', err);
  process.exit(1);
});
