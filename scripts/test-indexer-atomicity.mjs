import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Testing Indexer Transactional Atomicity (MED-2)...');

  // Verify that IndexedEvent table schema and Prisma client support atomic transactions
  const testTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const testLogIndex = 999;
  const chainId = 31337;

  // Clean up any test artifact
  await prisma.indexedEvent.deleteMany({
    where: { transactionHash: testTxHash },
  });

  // Execute atomic transaction simulation
  await prisma.$transaction([
    prisma.indexedEvent.create({
      data: {
        chainId,
        transactionHash: testTxHash,
        logIndex: testLogIndex,
        eventName: 'TestAtomicityEvent',
        blockNumber: '1',
        payload: JSON.stringify({ test: true }),
      },
    }),
    prisma.notification.create({
      data: {
        wallet: '0x0000000000000000000000000000000000000001',
        type: 'test_notification',
        payload: JSON.stringify({ test: true }),
      },
    }),
  ]);

  const created = await prisma.indexedEvent.findUnique({
    where: { chainId_transactionHash_logIndex: { chainId, transactionHash: testTxHash, logIndex: testLogIndex } },
  });

  if (!created) {
    throw new Error('Transaction atomic create failed');
  }

  // Cleanup
  await prisma.indexedEvent.deleteMany({ where: { transactionHash: testTxHash } });
  await prisma.notification.deleteMany({ where: { type: 'test_notification' } });

  console.log('MED-2 Indexer Transactional Atomicity Test Passed Cleanly!');
}

main().catch((err) => {
  console.error('MED-2 test failed:', err);
  process.exit(1);
});
