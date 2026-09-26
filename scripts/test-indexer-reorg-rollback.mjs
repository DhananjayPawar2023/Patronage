import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';

const prisma = new PrismaClient();
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const chainId = 31337;

async function main() {
  console.log('====================================================');
  console.log('  TESTING INDEXER BLOCK REORG & ROLLBACK RECOVERY   ');
  console.log('====================================================\n');

  const currentBlock = await client.getBlockNumber();
  console.log(`Current Anvil EVM block number: #${currentBlock}`);

  // 1. Fetch current indexer checkpoint
  const initialState = await prisma.indexerState.findUnique({ where: { chainId } });
  if (!initialState) {
    throw new Error('No IndexerState found for chain 31337. Run indexer first.');
  }

  const initialBlock = BigInt(initialState.lastProcessedBlock);
  console.log(`1. Initial Indexer Checkpoint:`);
  console.log(`   Block: #${initialBlock}`);
  console.log(`   Hash:  ${initialState.lastProcessedHash}`);
  console.log(`   Status: ${initialState.status}\n`);

  // Ensure there is at least one indexed event in the database to test rollback deletion
  const dummyTxHash = '0x1111222233334444555566667777888899990000111122223333444455556666';
  await prisma.indexedEvent.upsert({
    where: { chainId_transactionHash_logIndex: { chainId, transactionHash: dummyTxHash, logIndex: 999 } },
    create: {
      chainId,
      transactionHash: dummyTxHash,
      logIndex: 999,
      eventName: 'PreReorgTestEvent',
      blockNumber: initialBlock.toString(),
      payload: JSON.stringify({ test: 'should-be-rolled-back' }),
    },
    update: {},
  });

  const eventCountBefore = await prisma.indexedEvent.count();
  console.log(`2. Injected canary event. Total IndexedEvents before reorg: ${eventCountBefore}\n`);

  // 2. Induce a deliberate blockchain reorganization by corrupting the checkpoint hash
  const FORGED_REORG_HASH = '0xdeadbeef111122223333444455556666777788889999aaaabbbbccccddddeeee';
  console.log(`3. Inducing blockchain reorganization:`);
  console.log(`   Overwriting checkpoint hash with forged reorg hash: ${FORGED_REORG_HASH}...`);

  await prisma.indexerState.update({
    where: { chainId },
    data: {
      lastProcessedHash: FORGED_REORG_HASH,
    },
  });

  // Verify checkpoint now diverges from actual on-chain block hash
  const mutatedState = await prisma.indexerState.findUnique({ where: { chainId } });
  const actualBlock = await client.getBlock({ blockNumber: initialBlock });
  console.log(`   On-chain real block #${initialBlock} hash: ${actualBlock.hash}`);
  console.log(`   Indexer checkpoint mutated hash:       ${mutatedState.lastProcessedHash}`);

  if (actualBlock.hash === mutatedState.lastProcessedHash) {
    throw new Error('Failed to induce hash divergence for reorg test.');
  }
  console.log('   ✔ Hash divergence confirmed: Indexer state is now divergent from on-chain truth.\n');

  // 3. Inject a divergent ghost lot to test derived row pruning
  const ghostLotId = '999998';
  await prisma.lot.create({
    data: {
      chainId,
      auctionAddress: '0x0000000000000000000000000000000000000001',
      lotId: ghostLotId,
      nftAddress: '0x0000000000000000000000000000000000000001',
      tokenId: '999998',
      creator: '0x0000000000000000000000000000000000000001',
      metadataUri: 'ipfs://dummy-ghost-metadata-uri',
      reserveWei: '1000000000000000000',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      status: 'active',
      title: 'Divergent Ghost Lot',
    },
  });
  console.log('   Injected divergent ghost lot (#999998) to verify rollback pruning.');

  // 4. Wait for background indexer to detect hash mismatch, execute rollback, and replay
  console.log('4. Waiting for background indexer daemon to detect hash mismatch, execute rollback & replay...');
  let canaryPurged = false;
  let ghostPurged = false;
  let healedState = null;

  for (let i = 0; i < 40; i++) {
    const [canaryCount, ghost, st] = await Promise.all([
      prisma.indexedEvent.count({ where: { chainId, transactionHash: dummyTxHash } }),
      prisma.lot.findFirst({ where: { chainId, lotId: ghostLotId } }),
      prisma.indexerState.findUnique({ where: { chainId } }),
    ]);

    if (canaryCount === 0) canaryPurged = true;
    if (!ghost) ghostPurged = true;

    if (canaryPurged && ghostPurged && st && st.status === 'healthy' && st.lastProcessedHash !== FORGED_REORG_HASH) {
      healedState = st;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 5. Assert derived state was completely cleared and checkpoint healed
  console.log('\n5. Verifying Rollback Invariants:');
  console.log(`   - Canary event purged: ${canaryPurged}`);
  console.log(`   - Ghost lot purged:    ${ghostPurged}`);
  console.log(`   - Final status:        '${healedState?.status}'`);
  console.log(`   - Final block:         #${healedState?.lastProcessedBlock}`);
  console.log(`   - Healed hash:         ${healedState?.lastProcessedHash}`);

  if (!canaryPurged) throw new Error('Canary event was not purged by indexer reorg rollback!');
  if (!ghostPurged) throw new Error('Divergent ghost lot was not purged by indexer reorg rollback!');
  if (!healedState || healedState.status !== 'healthy') throw new Error('Indexer state did not return to healthy status after reorg replay!');
  if (healedState.lastProcessedHash === FORGED_REORG_HASH) throw new Error('Indexer checkpoint hash was not healed!');

  console.log('\n✔ All rollback invariants verified: Background indexer daemon purged divergent state and replayed on-chain events!');
}

main()
  .catch((err) => {
    console.error('Reorg rollback test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
