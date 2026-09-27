import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';

const prisma = new PrismaClient();
const client = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:8545') });
const chainId = 31337;

async function main() {
  console.log('================================================================');
  console.log('       RED TEAM AUDIT: INDEXER REORG & RESILIENCE SUITE         ');
  console.log('================================================================\n');

  const vulnerabilities = [];

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 1: Duplicate Event Injection / Idempotency Test
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [ATTACK 1] Testing Duplicate Blockchain Event Database Injection...');
  const fakeTxHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const contractAddr = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';

  // Insert event record 1
  await prisma.indexedEvent.create({
    data: {
      chainId,
      transactionHash: fakeTxHash,
      logIndex: 0,
      eventName: 'BidPlaced',
      blockNumber: '100',
      payload: JSON.stringify({ lotId: '1', bidder: '0x123', amount: '1000' }),
    },
  });

  // Attempt duplicate insert with same (chainId, transactionHash, logIndex)
  let duplicateRejected = false;
  try {
    await prisma.indexedEvent.create({
      data: {
        chainId,
        transactionHash: fakeTxHash,
        logIndex: 0,
        eventName: 'BidPlaced',
        blockNumber: '100',
        payload: JSON.stringify({ lotId: '1', bidder: '0x123', amount: '1000' }),
      },
    });
  } catch (err) {
    duplicateRejected = true;
  }

  // Cleanup test record
  await prisma.indexedEvent.deleteMany({
    where: { transactionHash: fakeTxHash },
  });

  if (!duplicateRejected) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Duplicate indexed event accepted without unique constraint violation!');
    vulnerabilities.push({
      id: 'INDEXER-DUPLICATE-EVENT-INGESTION',
      severity: 'HIGH',
      desc: 'Database allowed duplicate (chainId, contractAddress, txHash, logIndex) event record.',
    });
  } else {
    console.log('  ✔ Canonical blockchain event identity strictly enforced by composite unique constraint.');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 2: Ghost Row Reorg Pruning Verification
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 2] Testing Orphaned Fork Ghost Row Pruning on Hash Divergence...');
  const ghostLotId = '888888';
  await prisma.lot.create({
    data: {
      chainId,
      auctionAddress: contractAddr,
      lotId: ghostLotId,
      nftAddress: contractAddr,
      tokenId: '888888',
      creator: '0x0000000000000000000000000000000000000001',
      metadataUri: 'ipfs://ghost-metadata',
      reserveWei: '1000000000000000000',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      status: 'active',
      title: 'Red Team Ghost Lot',
    },
  });

  // Simulate hash divergence by setting forged hash in indexerState
  const FORGED_HASH = '0xfeedface0000111122223333444455556666777788889999aaaabbbbccccdddd';
  await prisma.indexerState.update({
    where: { chainId },
    data: { lastProcessedHash: FORGED_HASH },
  });

  console.log('  Simulated hash divergence, waiting for background daemon to prune ghost lot...');
  let ghostPruned = false;
  for (let i = 0; i < 20; i++) {
    const ghost = await prisma.lot.findFirst({ where: { chainId, lotId: ghostLotId } });
    if (!ghost) {
      ghostPruned = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (ghostPruned) {
    console.log('  ✔ Reorg divergence detected and ghost lot successfully purged from canonical state.');
  } else {
    console.log('  🚨 VULNERABILITY REPRODUCED: Orphaned fork ghost lot was not purged after reorg divergence!');
    vulnerabilities.push({
      id: 'INDEXER-REORG-GHOST-ROW-RETAINED',
      severity: 'CRITICAL',
      desc: 'Orphaned state was not pruned upon blockchain hash divergence.',
    });
    await prisma.lot.deleteMany({ where: { chainId, lotId: ghostLotId } });
  }

  console.log('\n================================================================');
  console.log(` RED TEAM INDEXER AUDIT FINISHED: ${vulnerabilities.length} VULNERABILITIES IDENTIFIED`);
  console.log('================================================================');
  await prisma.$disconnect();
  return vulnerabilities;
}

main().then((vulns) => {
  if (vulns.length > 0) {
    console.log('Vulnerabilities to fix:', vulns);
  }
}).catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
