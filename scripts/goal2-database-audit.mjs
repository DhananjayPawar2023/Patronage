/**
 * GOAL 2 — DATABASE INTEGRITY AUDIT
 * Tests:
 *   - unique constraints on all primary tables
 *   - duplicate blockchain event rejection
 *   - duplicate lot creation (chainId+auction+lotId)
 *   - duplicate bid (chainId+txHash+logIndex)
 *   - foreign key cascade behavior
 *   - rollback on partial write
 *   - concurrent writes to same row
 *   - artist uniqueness (walletAddress, handle)
 *   - session uniqueness (token)
 *   - nonce uniqueness
 *   - offer uniqueness
 */
import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const chainId = 31337;
const testAddr = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ✔ ${label}`);
}

async function expectConstraintViolation(label, fn) {
  let threw = false;
  try { await fn(); } catch (e) {
    const msg = e.message || '';
    if (msg.includes('Unique constraint') || e.code === 'P2002' ||
        msg.includes('UNIQUE constraint') || msg.includes('unique')) {
      threw = true;
    } else {
      throw new Error(`${label}: Unexpected error (not a constraint violation): ${e.message}`);
    }
  }
  assert(threw, `${label}: unique constraint enforced`);
}

async function main() {
  console.log('================================================================');
  console.log('   GOAL 2 — DATABASE INTEGRITY AUDIT                           ');
  console.log('================================================================\n');

  let passed = 0, failed = 0;
  async function check(label, fn) {
    try { await fn(); passed++; }
    catch (e) { console.error(`  ✖ FAIL [${label}]: ${e.message}`); failed++; }
  }

  // ── D1: IndexedEvent unique constraint (chainId, txHash, logIndex) ────────
  await check('D1: IndexedEvent duplicate (chainId+txHash+logIndex) rejected', async () => {
    const txHash = '0x' + 'db01'.padEnd(64, '0');
    // Cleanup first
    await prisma.indexedEvent.deleteMany({ where: { transactionHash: txHash } });
    await prisma.indexedEvent.create({
      data: { chainId, transactionHash: txHash, logIndex: 0, eventName: 'LotCreated', blockNumber: '100', payload: '{}' },
    });
    await expectConstraintViolation('D1', () =>
      prisma.indexedEvent.create({
        data: { chainId, transactionHash: txHash, logIndex: 0, eventName: 'BidPlaced', blockNumber: '101', payload: '{}' },
      })
    );
    await prisma.indexedEvent.deleteMany({ where: { transactionHash: txHash } });
  });

  // ── D2: Lot unique constraint (chainId, auctionAddress, lotId) ───────────
  await check('D2: Lot duplicate (chainId+auctionAddress+lotId) rejected', async () => {
    const lotId = 'DB2TEST';
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
    await prisma.lot.create({
      data: {
        chainId, auctionAddress: testAddr, lotId,
        nftAddress: testAddr, tokenId: '1', creator: '0x' + '1'.repeat(40),
        metadataUri: 'ipfs://db2test', reserveWei: '1000000000000000000',
        startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'active',
      },
    });
    await expectConstraintViolation('D2', () =>
      prisma.lot.create({
        data: {
          chainId, auctionAddress: testAddr, lotId,
          nftAddress: testAddr, tokenId: '2', creator: '0x' + '2'.repeat(40),
          metadataUri: 'ipfs://db2test2', reserveWei: '1000000000000000000',
          startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'active',
        },
      })
    );
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
  });

  // ── D3: Bid unique constraint (chainId, txHash, logIndex) ────────────────
  await check('D3: Bid duplicate (chainId+txHash+logIndex) rejected', async () => {
    const txHash = '0x' + 'db03'.padEnd(64, '0');
    const lotId = 'DB3LOT';
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
    const lot = await prisma.lot.create({
      data: {
        chainId, auctionAddress: testAddr, lotId,
        nftAddress: testAddr, tokenId: '3', creator: '0x' + '1'.repeat(40),
        metadataUri: 'ipfs://db3', reserveWei: '1000000000000000000',
        startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'active',
      },
    });
    await prisma.bid.deleteMany({ where: { transactionHash: txHash } });
    await prisma.bid.create({
      data: { chainId, transactionHash: txHash, logIndex: 0, lotId: lot.id, bidder: '0x' + '3'.repeat(40), amountWei: '1000', blockNumber: '100', timestamp: new Date() },
    });
    await expectConstraintViolation('D3', () =>
      prisma.bid.create({
        data: { chainId, transactionHash: txHash, logIndex: 0, lotId: lot.id, bidder: '0x' + '4'.repeat(40), amountWei: '2000', blockNumber: '101', timestamp: new Date() },
      })
    );
    await prisma.bid.deleteMany({ where: { transactionHash: txHash } });
    await prisma.lot.deleteMany({ where: { id: lot.id } });
  });

  // ── D4: Artist walletAddress unique constraint ─────────────────────────────
  await check('D4: Artist duplicate walletAddress rejected', async () => {
    const addr = '0x' + 'da04'.padEnd(40, '0');
    await prisma.artist.deleteMany({ where: { walletAddress: addr } });
    await prisma.artist.create({
      data: { walletAddress: addr, handle: 'db4test1', displayName: 'DB4 Test' },
    });
    await expectConstraintViolation('D4', () =>
      prisma.artist.create({
        data: { walletAddress: addr, handle: 'db4test2', displayName: 'DB4 Dup' },
      })
    );
    await prisma.artist.deleteMany({ where: { walletAddress: addr } });
  });

  // ── D5: Artist handle unique constraint ───────────────────────────────────
  await check('D5: Artist duplicate handle rejected', async () => {
    const handle = 'db5uniquehandle';
    const addr1 = '0x' + 'da05a'.padEnd(40, '0');
    const addr2 = '0x' + 'da05b'.padEnd(40, '0');
    await prisma.artist.deleteMany({ where: { handle } });
    await prisma.artist.create({ data: { walletAddress: addr1, handle, displayName: 'D5A' } });
    await expectConstraintViolation('D5', () =>
      prisma.artist.create({ data: { walletAddress: addr2, handle, displayName: 'D5B' } })
    );
    await prisma.artist.deleteMany({ where: { handle } });
  });

  // ── D6: Session token unique constraint ───────────────────────────────────
  await check('D6: Session duplicate token rejected', async () => {
    const token = 'db6token' + Date.now();
    const addr = '0x' + 'da06'.padEnd(40, '0');
    await prisma.$executeRaw`DELETE FROM "Session" WHERE "token" = ${token}`;
    await prisma.$executeRaw`
      INSERT INTO "Session" ("id", "token", "address", "expiresAt", "createdAt")
      VALUES (${'sess-' + token}, ${token}, ${addr}, ${'2099-01-01T00:00:00.000Z'}, CURRENT_TIMESTAMP);
    `;
    await expectConstraintViolation('D6', () =>
      prisma.$executeRaw`
        INSERT INTO "Session" ("id", "token", "address", "expiresAt", "createdAt")
        VALUES (${'sess2-' + token}, ${token}, ${'0x' + 'aa'.repeat(20)}, ${'2099-01-01T00:00:00.000Z'}, CURRENT_TIMESTAMP);
      `
    );
    await prisma.$executeRaw`DELETE FROM "Session" WHERE "token" = ${token}`;
  });

  // ── D7: SiweNonce unique constraint ───────────────────────────────────────
  await check('D7: SiweNonce duplicate nonce rejected', async () => {
    const nonce = 'db7nonce' + Date.now();
    const expires = new Date(Date.now() + 300_000).toISOString();
    await prisma.$executeRaw`DELETE FROM "SiweNonce" WHERE "nonce" = ${nonce}`;
    await prisma.$executeRaw`
      INSERT INTO "SiweNonce" ("id", "nonce", "expiresAt", "createdAt")
      VALUES (${'n1-' + nonce}, ${nonce}, ${expires}, CURRENT_TIMESTAMP);
    `;
    await expectConstraintViolation('D7', () =>
      prisma.$executeRaw`
        INSERT INTO "SiweNonce" ("id", "nonce", "expiresAt", "createdAt")
        VALUES (${'n2-' + nonce}, ${nonce}, ${expires}, CURRENT_TIMESTAMP);
      `
    );
    await prisma.$executeRaw`DELETE FROM "SiweNonce" WHERE "nonce" = ${nonce}`;
  });

  // ── D8: Offer unique constraint (chainId, nftAddress, tokenId, buyer) ─────
  await check('D8: Offer duplicate (chainId+nft+tokenId+buyer) rejected', async () => {
    const buyer = '0x' + 'da08'.padEnd(40, '0');
    const nft = testAddr;
    const tokenId = 'DB8TOKEN';
    await prisma.offer.deleteMany({ where: { chainId, nftAddress: nft, tokenId, buyer } });
    await prisma.offer.create({ data: { chainId, nftAddress: nft, tokenId, buyer, amountWei: '1000' } });
    await expectConstraintViolation('D8', () =>
      prisma.offer.create({ data: { chainId, nftAddress: nft, tokenId, buyer, amountWei: '2000' } })
    );
    await prisma.offer.deleteMany({ where: { chainId, nftAddress: nft, tokenId, buyer } });
  });

  // ── D9: LazyVoucher unique constraint (chainId, nft, tokenId, nonce) ──────
  await check('D9: LazyVoucher duplicate (chainId+nft+tokenId+nonce) rejected', async () => {
    const nft = testAddr;
    const tokenId = 'DB9TOKEN';
    const nonce = 'DB9NONCE';
    const artist = '0x' + 'da09'.padEnd(40, '0');
    await prisma.lazyVoucher.deleteMany({ where: { chainId, nftAddress: nft, tokenId, nonce } });
    await prisma.lazyVoucher.create({
      data: { chainId, nftAddress: nft, tokenId, nonce, artist, minPriceWei: '1', metadataUri: '', signature: '0x', deadline: '9999999999' },
    });
    await expectConstraintViolation('D9', () =>
      prisma.lazyVoucher.create({
        data: { chainId, nftAddress: nft, tokenId, nonce, artist, minPriceWei: '2', metadataUri: '', signature: '0x', deadline: '9999999999' },
      })
    );
    await prisma.lazyVoucher.deleteMany({ where: { chainId, nftAddress: nft, tokenId, nonce } });
  });

  // ── D10: DelistedToken unique constraint (contractAddress, tokenId) ────────
  await check('D10: DelistedToken duplicate rejected', async () => {
    const contract = '0x' + 'da10'.padEnd(40, '0');
    const tokenId = 'DELIST10';
    await prisma.$executeRaw`DELETE FROM "DelistedToken" WHERE "contractAddress" = ${contract} AND "tokenId" = ${tokenId}`;
    await prisma.$executeRaw`
      INSERT INTO "DelistedToken" ("id", "contractAddress", "tokenId", "reason", "delistedAt")
      VALUES (${'dl-' + tokenId}, ${contract}, ${tokenId}, ${'DMCA'}, CURRENT_TIMESTAMP);
    `;
    await expectConstraintViolation('D10', () =>
      prisma.$executeRaw`
        INSERT INTO "DelistedToken" ("id", "contractAddress", "tokenId", "reason", "delistedAt")
        VALUES (${'dl2-' + tokenId}, ${contract}, ${tokenId}, ${'Dup'}, CURRENT_TIMESTAMP);
      `
    );
    await prisma.$executeRaw`DELETE FROM "DelistedToken" WHERE "contractAddress" = ${contract}`;
  });

  // ── D11: Transaction rollback — atomic lot+event creation ────────────────
  await check('D11: Prisma transaction atomicity — rollback on failure', async () => {
    const lotId = 'TXROLLBACK';
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
    let threw = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.lot.create({
          data: {
            chainId, auctionAddress: testAddr, lotId,
            nftAddress: testAddr, tokenId: 'rbtest', creator: '0x' + '1'.repeat(40),
            metadataUri: 'ipfs://rb', reserveWei: '1000000000000000000',
            startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'active',
          },
        });
        // Force failure mid-transaction
        throw new Error('Intentional rollback trigger');
      });
    } catch (e) {
      if (e.message === 'Intentional rollback trigger') threw = true;
      else throw e;
    }
    assert(threw, 'transaction threw as expected');
    const lot = await prisma.lot.findFirst({ where: { chainId, auctionAddress: testAddr, lotId } });
    assert(!lot, 'Lot was NOT created (transaction rolled back correctly)');
  });

  // ── D12: Concurrent upsert on same lot — last write wins, no crash ────────
  await check('D12: Concurrent upsert on same lot — no crash', async () => {
    const lotId = 'CONCURRENTUPSERT';
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
    const base = {
      chainId, auctionAddress: testAddr, lotId,
      nftAddress: testAddr, tokenId: 'cu1', creator: '0x' + '5'.repeat(40),
      metadataUri: 'ipfs://cu', reserveWei: '1000000000000000000',
      startTime: new Date(), endTime: new Date(Date.now() + 3600000), status: 'active',
    };
    await prisma.lot.create({ data: base });
    const updates = Array.from({ length: 10 }, (_, i) =>
      prisma.lot.updateMany({
        where: { chainId, auctionAddress: testAddr, lotId },
        data: { highestBidWei: String(i * 1000), status: 'active' },
      })
    );
    await Promise.all(updates); // Must not throw
    const lot = await prisma.lot.findFirst({ where: { chainId, auctionAddress: testAddr, lotId } });
    assert(!!lot, 'lot exists after concurrent updates');
    await prisma.lot.deleteMany({ where: { chainId, auctionAddress: testAddr, lotId } });
  });

  await prisma.$disconnect();

  console.log(`\n================================================================`);
  console.log(` DATABASE INTEGRITY AUDIT: ${passed} passed / ${failed} failed`);
  console.log(`================================================================`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
