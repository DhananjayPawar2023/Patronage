import { execSync } from 'node:child_process';

const steps = [
  { name: '1. Compile Solidity Contracts', cmd: 'node scripts/compile-contracts.mjs' },
  { name: '2. Run Foundry Test Suite (58/58 + 128k Fuzz + Invariants)', cmd: 'node scripts/forge.mjs test' },
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
  { name: '13. P0 SIWE Nonce Concurrency & Validation Security', cmd: 'node scripts/test-siwe-concurrency.mjs' },
  { name: '14. P1 Storage & File Upload Traversal/Magic-Bytes Security', cmd: 'node scripts/test-upload-security.mjs' },
  { name: '15. P1 API Authorization & Security Headers', cmd: 'node scripts/test-api-security.mjs' },
  { name: '16. 25-Step Master End-to-End Acceptance Flow', cmd: 'node scripts/test-master-acceptance-flow.mjs' },
  { name: '17. True Chain-Level Reorg via evm_snapshot/revert', cmd: 'node scripts/test-real-chain-reorg.mjs' },
  { name: '18. Indexer Process Kill/Restart Durability', cmd: 'node scripts/test-indexer-kill-restart.mjs' },
  { name: '19. Vendored Indexer Durable SQLite Storage & Checkpoint', cmd: 'node scripts/test-vendored-indexer-durability.mjs' },
  { name: '20. PostgreSQL Schema & Raw SQL Dialect Portability', cmd: 'node scripts/test-postgresql-compatibility.mjs' },
  { name: '21. EIP-712 Gasless Lazy Minting & On-Chain Escrowed Offers Flow', cmd: 'node scripts/test-offers-and-lazymint-flow.mjs' },
  { name: '22. Red-Team SIWE & Concurrency Attack Suite', cmd: 'node scripts/redteam/redteam-siwe.mjs' },
  { name: '23. Red-Team Storage & File Upload Attack Suite', cmd: 'node scripts/redteam/redteam-storage.mjs' },
  { name: '24. Red-Team EIP-712 Voucher & Lazy Mint Attack Suite', cmd: 'node scripts/redteam/redteam-vouchers.mjs' },
  { name: '25. Red-Team API RBAC & Boundary Attack Suite', cmd: 'node scripts/redteam/redteam-api.mjs' },
  { name: '26. Red-Team Indexer Resilience & Reorg Attack Suite', cmd: 'node scripts/redteam/redteam-indexer.mjs' },
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
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    if (!err.stdout && !err.stderr) console.error(err.message);
    process.exit(1);
  }
}

console.log('\n================================================================');
console.log(` ALL ${passed}/${steps.length} VERIFICATION PIPELINES PASSED WITH ZERO ERRORS!`);
console.log('================================================================\n');
