import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ddl = [
  `CREATE TABLE IF NOT EXISTS "Artist" (
    "id" TEXT PRIMARY KEY,
    "walletAddress" TEXT UNIQUE NOT NULL,
    "handle" TEXT UNIQUE NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "Lot" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "auctionAddress" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "nftAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "metadataUri" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    "artistName" TEXT,
    "artistHandle" TEXT,
    "reserveWei" TEXT NOT NULL,
    "minIncrementWei" TEXT,
    "highestBidWei" TEXT NOT NULL DEFAULT '0',
    "highestBidder" TEXT,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'indexed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "artistId" TEXT,
    FOREIGN KEY ("artistId") REFERENCES "Artist" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Lot_chainId_auctionAddress_lotId_key" ON "Lot"("chainId", "auctionAddress", "lotId");`,
  `CREATE TABLE IF NOT EXISTS "Bid" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "bidder" TEXT NOT NULL,
    "amountWei" TEXT NOT NULL,
    "blockNumber" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL,
    FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Bid_chainId_transactionHash_logIndex_key" ON "Bid"("chainId", "transactionHash", "logIndex");`,
  `CREATE TABLE IF NOT EXISTS "PatronMint" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "minter" TEXT NOT NULL,
    "blockNumber" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PatronMint_chainId_transactionHash_logIndex_key" ON "PatronMint"("chainId", "transactionHash", "logIndex");`,
  `CREATE TABLE IF NOT EXISTS "IndexedEvent" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "eventName" TEXT NOT NULL,
    "blockNumber" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "IndexedEvent_chainId_transactionHash_logIndex_key" ON "IndexedEvent"("chainId", "transactionHash", "logIndex");`,
  `CREATE TABLE IF NOT EXISTS "IndexerState" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER UNIQUE NOT NULL,
    "lastProcessedBlock" TEXT NOT NULL DEFAULT '0',
    "lastProcessedHash" TEXT,
    "currentBlock" TEXT NOT NULL DEFAULT '0',
    "lastSyncAt" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "deadLetterCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT PRIMARY KEY,
    "wallet" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS "DelistedToken" (
    "id" TEXT PRIMARY KEY,
    "contractAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "delistedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DelistedToken_contractAddress_tokenId_key" ON "DelistedToken"("contractAddress", "tokenId");`,
  `CREATE TABLE IF NOT EXISTS "SiweNonce" (
    "id" TEXT PRIMARY KEY,
    "nonce" TEXT UNIQUE NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SiweNonce_nonce_key" ON "SiweNonce"("nonce");`,
  `CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT PRIMARY KEY,
    "token" TEXT UNIQUE NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token");`,
  `CREATE TABLE IF NOT EXISTS "Offer" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "nftAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "amountWei" TEXT NOT NULL,
    "counterAmountWei" TEXT NOT NULL DEFAULT '0',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Offer_chainId_nftAddress_tokenId_buyer_key" ON "Offer"("chainId", "nftAddress", "tokenId", "buyer");`,
  `CREATE TABLE IF NOT EXISTS "LazyVoucher" (
    "id" TEXT PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "nftAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "minPriceWei" TEXT NOT NULL,
    "metadataUri" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    "artistName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "redeemedBy" TEXT,
    "redeemedTx" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LazyVoucher_chainId_nftAddress_tokenId_nonce_key" ON "LazyVoucher"("chainId", "nftAddress", "tokenId", "nonce");`,
];

export async function initDatabase() {
  console.log('[db] Initializing database tables...');
  for (const sql of ddl) {
    await prisma.$executeRawUnsafe(sql);
  }
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Lot" ADD COLUMN "buyNowWei" TEXT;`);
  } catch {}
  console.log('[db] Database schema verified & ready.');
}

if (process.argv[1] && process.argv[1].endsWith('init-db.mjs')) {
  initDatabase()
    .then(() => prisma.$disconnect())
    .catch((err) => {
      console.error('[db] Error initializing database:', err);
      process.exit(1);
    });
}
