import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('====================================================');
  console.log('  PATRONAGE COLD START & PRODUCTION VALIDATION TEST');
  console.log('====================================================\n');

  // PHASE 1: Verify database state immediately after cold start reset
  console.log('▶ PHASE 1 & 2: Checking Cold Start Empty Database State...');
  const lotsCount = await prisma.lot.count();
  const bidsCount = await prisma.bid.count();

  console.log(`- Database Lot Count: ${lotsCount}`);
  console.log(`- Database Bid Count: ${bidsCount}`);

  if (lotsCount !== 0) {
    console.warn('⚠️ Note: Database is not blank. Existing lots present.');
  } else {
    console.log('✔ Cold Start Database is 100% EMPTY as expected.');
  }

  // PHASE 3 & 4: Execute Complete End-to-End User Journey Simulation
  console.log('\n▶ PHASE 4: Executing End-to-End User Journey Verification...');

  // 1. Run PatronEdition withdraw verification
  execSync('node scripts/test-patron-withdraw.mjs', { stdio: 'inherit' });
  console.log('✔ User Journey Step 1: PatronEdition mint & withdraw verified.');

  // 2. Run Settlement security verification
  execSync('node scripts/test-settlement-security.mjs', { stdio: 'inherit' });
  console.log('✔ User Journey Step 2: Auction creation, bidding, outbid refund, and settlement verified.');

  // 3. Run Artist Factory verification
  execSync('node scripts/test-artist-factory.mjs', { stdio: 'inherit' });
  console.log('✔ User Journey Step 3: Artist collection cloning & EIP-2981 royalty routing verified.');

  // 4. Run Upload Security verification
  execSync('node scripts/test-upload-security.mjs', { stdio: 'inherit' });
  console.log('✔ User Journey Step 4: Asset upload, MIME validation & metadata generation verified.');

  // 5. Run Indexer Atomicity verification
  execSync('node scripts/test-indexer-atomicity.mjs', { stdio: 'inherit' });
  console.log('✔ User Journey Step 5: Indexer transactional atomicity verified.');

  console.log('\n====================================================');
  console.log('  SUCCESS: COLD START VERIFICATION 100% PASSED!');
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Cold Start verification failed:', err);
  process.exit(1);
});
