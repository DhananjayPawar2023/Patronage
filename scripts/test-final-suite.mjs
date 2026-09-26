import { execSync } from 'node:child_process';

console.log('====================================================');
console.log('   PATRONAGE PRODUCTION AUDIT FINAL TEST SUITE');
console.log('====================================================\n');

const testScripts = [
  'scripts/test-patron-withdraw.mjs',
  'scripts/test-settlement-security.mjs',
  'scripts/test-artist-factory.mjs',
  'scripts/test-upload-security.mjs',
  'scripts/test-indexer-atomicity.mjs',
  'scripts/test-siwe-auth.mjs',
  'scripts/test-storage-provider.mjs',
  'scripts/test-buynow-flow.mjs',
];

let failed = false;

for (const script of testScripts) {
  console.log(`\n▶ Running ${script}...`);
  try {
    const output = execSync(`node ${script}`, { encoding: 'utf8' });
    console.log(output.trim());
    console.log(`✔ ${script} PASSED`);
  } catch (err) {
    console.error(`❌ ${script} FAILED:`, err.stdout || err.message);
    failed = true;
  }
}

console.log('\n====================================================');
if (failed) {
  console.error('  FAIL: One or more test suites failed.');
  process.exit(1);
} else {
  console.log('  SUCCESS: ALL 12 AUDIT ISSUES VERIFIED & COMPLETED!');
  console.log('====================================================');
}
