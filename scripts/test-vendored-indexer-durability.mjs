import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TEST_DB = path.resolve('data/verify-vendored-durable.db');

// Ensure clean slate
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB + ext)) {
    fs.unlinkSync(TEST_DB + ext);
  }
}

console.log('================================================================');
console.log('       VENDORED INDEXER DURABLE SQLITE STORAGE VERIFIER         ');
console.log('================================================================\n');

try {
  console.log('▶ [1/3] Executing initial sync into durable SQLite storage...');
  const env = {
    ...process.env,
    INDEXER_ONCE: 'true',
    INDEXER_REPLAY_FROM: '0',
    VENDORED_INDEXER_DB_PATH: TEST_DB,
  };

  const output1 = execSync('node services/indexer/vendored-adapter.mjs', {
    env,
    encoding: 'utf8',
  });
  console.log(output1.trim());

  if (!fs.existsSync(TEST_DB)) {
    throw new Error(`Expected durable database file at ${TEST_DB}, but none was found!`);
  }

  console.log('\n▶ [2/3] Inspecting persisted SQLite tables and rows on disk...');
  const db = new DatabaseSync(TEST_DB);
  const dataCount = db.prepare('SELECT count(*) as c FROM _data').get().c;
  const eventsCount = db.prepare('SELECT count(*) as c FROM _events').get().c;
  const cursors = db.prepare('SELECT * FROM _cursors').all();
  const lots = db.prepare('SELECT count(*) as c FROM _data WHERE table_name = \'lots\'').get().c;
  const bids = db.prepare('SELECT count(*) as c FROM _data WHERE table_name = \'bids\'').get().c;

  console.log(`  - Persisted data rows: ${dataCount}`);
  console.log(`  - Persisted raw events: ${eventsCount}`);
  console.log(`  - Persisted cursors count: ${cursors.length}`);
  console.log(`  - Persisted indexed lots: ${lots}`);
  console.log(`  - Persisted indexed bids: ${bids}`);

  if (dataCount === 0 || lots === 0) {
    throw new Error('Durable SQLite store contains 0 records after sync!');
  }
  if (cursors.length === 0) {
    throw new Error('No block cursors were recorded in _cursors table!');
  }

  const ahCursor = cursors.find((c) => c.name.includes('AuctionHouse'));
  if (!ahCursor || Number(ahCursor.block) === 0) {
    throw new Error(`Expected non-zero block cursor, got ${JSON.stringify(ahCursor)}`);
  }
  const lastBlock = Number(ahCursor.block);
  console.log(`  ✔ AuctionHouse cursor securely checkpointed at block: ${lastBlock}`);
  db.close();

  console.log('\n▶ [3/3] Testing resume from durable checkpoint (no block 0 replay)...');
  const envResume = {
    ...process.env,
    INDEXER_ONCE: 'true',
    VENDORED_INDEXER_DB_PATH: TEST_DB,
  };
  delete envResume.INDEXER_REPLAY_FROM;

  const output2 = execSync('node services/indexer/vendored-adapter.mjs', {
    env: envResume,
    encoding: 'utf8',
  });
  console.log(output2.trim());

  // The adapter's process-level log uses the Prisma checkpoint, while the
  // vendored engine resumes each contract from its own SQLite cursor. Assert
  // against the actual first SQLite-backed sync chunk; Anvil may mine between
  // the two one-shot processes, so requiring an exact global "starting from"
  // number is race-prone and can reject a correct resume.
  if (!output2.includes(`chunk ${lastBlock + 1}->`) || output2.includes('chunk 0->')) {
    throw new Error(`Expected vendored store resume at block ${lastBlock + 1} (not block zero), but output was:\n${output2}`);
  }
  console.log(`  ✔ Verified clean resume from block ${lastBlock + 1} without re-fetching historical blocks!`);

  console.log('\n================================================================');
  console.log(' ✔ VENDORED DURABLE SQLITE STORAGE & RESUME FULLY VERIFIED!');
  console.log('================================================================\n');
} finally {
  // Cleanup test database
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(TEST_DB + ext)) {
      try {
        fs.unlinkSync(TEST_DB + ext);
      } catch {}
    }
  }
}
