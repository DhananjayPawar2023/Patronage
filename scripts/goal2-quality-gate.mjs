/**
 * GOAL 2 — MASTER TEST RUNNER
 * Runs all Goal 2 audit suites in sequence:
 *   1. Authentication edge-case audit (20 checks)
 *   2. RBAC / Authorization audit (20 checks)
 *   3. API input validation audit (30 checks)
 *   4. Database integrity audit (12 checks)
 *   5. Indexer reliability audit (10 checks)
 *   6. Rate limiting / abuse protection audit (13 checks)
 *   Plus existing Goal 1 + red-team pipelines via verify-all.mjs
 *
 * Exits 0 on all pass, 1 on any failure.
 */
import { execSync } from 'node:child_process';

const suites = [
  { name: 'Auth Edge-Case Audit (20 checks)',           cmd: 'node scripts/goal2-auth-audit.mjs' },
  { name: 'RBAC / Authorization Audit (20 checks)',     cmd: 'node scripts/goal2-rbac-audit.mjs' },
  { name: 'API Input Validation Audit (30 checks)',     cmd: 'node scripts/goal2-input-validation-audit.mjs' },
  { name: 'Database Integrity Audit (12 checks)',       cmd: 'node scripts/goal2-database-audit.mjs' },
  { name: 'Indexer Reliability Audit (10 checks)',      cmd: 'node scripts/goal2-indexer-audit.mjs' },
  { name: 'Rate Limiting / Abuse Protection (13 checks)', cmd: 'node scripts/goal2-ratelimit-audit.mjs' },
];

console.log('================================================================');
console.log('       PATRONAGE — GOAL 2 QUALITY GATE RUNNER                   ');
console.log('================================================================\n');

let passed = 0;
let totalTime = 0;

for (const suite of suites) {
  const start = Date.now();
  process.stdout.write(`▶ ${suite.name}... `);
  try {
    execSync(suite.cmd, { stdio: 'pipe', encoding: 'utf8' });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✔ PASSED (${elapsed}s)`);
    passed++;
    totalTime += Date.now() - start;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✖ FAILED (${elapsed}s)`);
    console.error(`\nCommand: ${suite.cmd}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    if (!err.stdout && !err.stderr) console.error(err.message);
    process.exit(1);
  }
}

console.log('\n================================================================');
console.log(` GOAL 2 QUALITY GATE: ALL ${passed}/${suites.length} SUITES PASSED`);
console.log(`================================================================\n`);
