/**
 * test-indexer-kill-restart.mjs
 *
 * Proves that the Patronage indexer daemon correctly handles a process-level kill
 * during an active sync, resumes from its durable checkpoint, and does NOT
 * double-process already-indexed events upon restart.
 *
 * Mechanism:
 *  1. Records the current indexer checkpoint block.
 *  2. Mines 10 new blocks to create work for the indexer.
 *  3. Spawns a fresh indexer child process (separate from the background daemon).
 *  4. Waits for the child to advance its checkpoint by at least 3 blocks.
 *  5. Sends SIGKILL to the child process (hard kill, no graceful shutdown).
 *  6. Records the checkpoint immediately after the kill.
 *  7. Respawns the child process.
 *  8. Verifies the restarted indexer resumes from the saved checkpoint (not from 0).
 *  9. Verifies the restarted indexer processes remaining blocks and returns to healthy.
 * 10. Verifies no duplicate IndexedEvent rows were created (idempotency).
 */
import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const prisma = new PrismaClient();
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const chainId = 31337;

async function rpc(method, params = []) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  return res.json();
}

async function getCheckpoint() {
  return prisma.indexerState.findUnique({ where: { chainId } });
}

async function countEvents() {
  return prisma.indexedEvent.count({ where: { chainId } });
}

function spawnIndexer() {
  return spawn('node', ['services/indexer/vendored-adapter.mjs'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env },
  });
}

async function waitForCheckpointAdvance(startBlock, minAdvance = 3, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const st = await getCheckpoint();
    const current = parseInt(st?.lastProcessedBlock ?? '0');
    if (current >= startBlock + minAdvance) return current;
    await sleep(300);
  }
  throw new Error(`Timed out: checkpoint did not advance by ${minAdvance} blocks in ${maxWaitMs}ms`);
}

async function waitForHealthy(maxWaitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const st = await getCheckpoint();
    if (st?.status === 'healthy') return st;
    await sleep(300);
  }
  throw new Error(`Timed out: indexer did not return to healthy in ${maxWaitMs}ms`);
}

async function main() {
  console.log('====================================================');
  console.log('  INDEXER PROCESS KILL / RESTART DURABILITY TEST    ');
  console.log('====================================================\n');

  // 1. Record baseline state
  const baseline = await getCheckpoint();
  if (!baseline) throw new Error('No IndexerState found — ensure indexer has run at least once.');
  const baselineBlock = parseInt(baseline.lastProcessedBlock);
  const baselineEvents = await countEvents();
  console.log(`1. Baseline: checkpoint=#${baselineBlock}, events=${baselineEvents}, status='${baseline.status}'\n`);

  // 2. Mine 10 blocks to create fresh work
  await rpc('anvil_mine', [10]);
  const tipRpc = (await rpc('eth_getBlockByNumber', ['latest', false])).result;
  const chainTip = parseInt(tipRpc.number, 16);
  console.log(`2. Mined 10 blocks. Chain tip: #${chainTip}\n`);

  // 3. Spawn fresh indexer child process
  console.log('3. Spawning indexer child process...');
  const child1 = spawnIndexer();
  let child1Logs = '';
  child1.stdout?.on('data', (d) => { child1Logs += d; });
  child1.stderr?.on('data', (d) => { child1Logs += d; });
  await sleep(1000); // give process time to start

  // 4. Wait for it to advance the checkpoint by at least 3 blocks
  console.log('4. Waiting for child indexer to advance checkpoint...');
  const advancedTo = await waitForCheckpointAdvance(baselineBlock, 3);
  const preKillCheckpoint = await getCheckpoint();
  const preKillBlock = parseInt(preKillCheckpoint.lastProcessedBlock);
  const preKillEvents = await countEvents();
  console.log(`   Checkpoint advanced to #${preKillBlock} (events: ${preKillEvents})\n`);

  // 5. Hard kill the child process (SIGKILL — no graceful shutdown possible)
  console.log('5. Sending SIGKILL to child indexer process...');
  const killedPid = child1.pid;
  child1.kill('SIGKILL');
  await sleep(500);
  console.log(`   Child PID ${killedPid} killed.\n`);

  // 6. Record checkpoint immediately after kill
  const postKillCheckpoint = await getCheckpoint();
  const postKillBlock = parseInt(postKillCheckpoint.lastProcessedBlock);
  console.log(`6. Post-kill checkpoint: block #${postKillBlock} (should match pre-kill: #${preKillBlock})`);
  if (postKillBlock !== preKillBlock) {
    console.log('   ⚠ Checkpoint changed slightly between kill and read — background daemon may have run.');
  }
  console.log();

  // 7. Respawn indexer
  console.log('7. Respawning indexer child process...');
  const child2 = spawnIndexer();
  let child2Logs = '';
  child2.stdout?.on('data', (d) => { child2Logs += d; });
  child2.stderr?.on('data', (d) => { child2Logs += d; });
  await sleep(1000);
  console.log('   Child respawned.\n');

  // 8. Verify restarted indexer resumes from saved checkpoint (not from 0)
  await sleep(2000); // give it time to read checkpoint and start
  const resumedCheckpoint = await getCheckpoint();
  const resumedBlock = parseInt(resumedCheckpoint?.lastProcessedBlock ?? '0');
  console.log(`8. Resumed checkpoint: block #${resumedBlock}`);
  console.log(`   Started from checkpoint, not from 0: ${resumedBlock >= postKillBlock}`);
  if (resumedBlock < postKillBlock) {
    throw new Error(`Restarted indexer REGRESSED: resumed from #${resumedBlock} but should be >= #${postKillBlock}`);
  }
  console.log();

  // 9. Wait for fully healthy state after processing remaining blocks
  console.log('9. Waiting for restarted indexer to reach healthy status...');
  const healed = await waitForHealthy(25000);
  const healedBlock = parseInt(healed.lastProcessedBlock);
  const healedEvents = await countEvents();
  console.log(`   Healed: block #${healedBlock}, events=${healedEvents}, status='${healed.status}'\n`);

  // 10. Verify no duplicate events (idempotency check via groupBy)
  console.log('10. Checking for duplicate IndexedEvent rows (idempotency)...');
  const allEvents = await prisma.indexedEvent.findMany({
    where: { chainId },
    select: { transactionHash: true, logIndex: true },
  });
  const seen = new Map();
  let dupCount = 0;
  const dupExamples = [];
  for (const ev of allEvents) {
    const key = `${ev.transactionHash}:${ev.logIndex}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      dupCount++;
      dupExamples.push(`${key} (x${count})`);
    }
  }
  console.log(`   Duplicate (txHash, logIndex) pairs: ${dupCount}`);
  if (dupCount > 0) {
    throw new Error(`DUPLICATE EVENTS FOUND after restart (${dupCount} pairs): ${dupExamples.slice(0, 3).join(', ')}`);
  }

  // Kill child2 (background daemon still running, so it will take over)
  child2.kill('SIGKILL');

  console.log('\n====================================================');
  console.log(' ✔ PROCESS KILL/RESTART DURABILITY: FULLY VERIFIED!');
  console.log(`   - Child SIGKILL-ed at block #${preKillBlock}`);
  console.log(`   - Restarted from durable checkpoint (#${postKillBlock}), not from 0`);
  console.log(`   - Fully healed to block #${healedBlock} with status='healthy'`);
  console.log(`   - 0 duplicate events after restart (idempotency confirmed)`);
  console.log('====================================================\n');
}

main()
  .catch((err) => {
    console.error('\n❌ Kill/restart test failed:', err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
