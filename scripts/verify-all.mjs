import { execSync } from 'node:child_process';

const steps = [
  { name: '1. Compile Solidity Contracts', cmd: 'node scripts/compile-contracts.mjs' },
  { name: '2. Run Foundry Test Suite (30/30 + 128k Fuzz)', cmd: 'tools\\foundry\\forge.exe test --root contracts' },
  { name: '3. Full Repository Anvil Key & Mnemonic Audit', cmd: 'node scripts/verify-backend-and-full-repo.mjs' },
  { name: '4. RBAC Authorization & Durable Session Persistence', cmd: 'node scripts/test-rbac-and-durable-auth.mjs' },
  { name: '5. Sync Live OFAC SDN Sanctions Feed (124+ Addresses)', cmd: 'node scripts/sync-sanctions.mjs' },
  { name: '6. Compliance Verification (Live SDN, Delist, Tax CSV)', cmd: 'node scripts/test-compliance-features.mjs' },
  { name: '7. Sanctions Scheduler & Admin API Integration', cmd: 'node scripts/test-sanctions-scheduler.mjs' },
  { name: '8. Indexer Checkpoint & Idempotency Audit', cmd: 'node scripts/test-indexer-durability.mjs' },
  { name: '9. Exercise Indexer Block Reorg Rollback Path', cmd: 'node scripts/test-indexer-reorg-rollback.mjs' },
  { name: '10. Frontend Production Build & Bundle Audit', cmd: 'npm run build' },
  { name: '11. Audit dist/ for Keys and Sourcemaps', cmd: 'node scripts/verify-exhaustive-keys.mjs' },
  { name: '12. SIWE Session & Nonce Periodic Maintenance Pruner', cmd: 'node scripts/test-session-pruning.mjs' },
  { name: '13. 25-Step Master End-to-End Acceptance Flow', cmd: 'node scripts/test-master-acceptance-flow.mjs' },
  { name: '14. True Chain-Level Reorg via evm_snapshot/revert', cmd: 'node scripts/test-real-chain-reorg.mjs' },
  { name: '15. Indexer Process Kill/Restart Durability', cmd: 'node scripts/test-indexer-kill-restart.mjs' },
  { name: '16. Vendored Indexer Durable SQLite Storage & Checkpoint', cmd: 'node scripts/test-vendored-indexer-durability.mjs' },
  { name: '17. PostgreSQL Schema & Raw SQL Dialect Portability', cmd: 'node scripts/test-postgresql-compatibility.mjs' },
  { name: '18. EIP-712 Gasless Lazy Minting & On-Chain Escrowed Offers Flow', cmd: 'node scripts/test-offers-and-lazymint-flow.mjs' },
];

console.log('================================================================');
console.log('       PATRONAGE PLATFORM AUTOMATED PRE-FLIGHT VERIFIER         ');
console.log('================================================================\n');

let passed = 0;
for (const step of steps) {
  process.stdout.write(`▶ ${step.name}... `);
  try {
    execSync(step.cmd, { stdio: 'pipe', encoding: 'utf8' });
    console.log('✔ PASSED');
    passed++;
  } catch (err) {
    console.log('✖ FAILED');
    console.error(`\nCommand: ${step.cmd}`);
    console.error(err.stdout || err.stderr || err.message);
    process.exit(1);
  }
}

console.log('\n================================================================');
console.log(` ALL ${passed}/${steps.length} VERIFICATION PIPELINES PASSED WITH ZERO ERRORS!`);
console.log('================================================================\n');
