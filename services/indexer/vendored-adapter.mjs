import fs from 'node:fs';
import path from 'node:path';
import '../../src/config/load-env.mjs';
import { createPublicClient, http, formatEther, parseAbiItem } from 'viem';
import { foundry } from 'viem/chains';
import { PrismaClient } from '@prisma/client';
import { createIndexer } from '../../packages/simple-indexer/dist/index.js';
import { createSqliteStore } from '../../packages/simple-indexer/dist/sqlite.js';

const prisma = new PrismaClient();
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const deploymentPath = path.resolve('contracts/deployments/31337.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const chainId = Number(deployment.chainId || 31337);
const auctionAddress = deployment.contracts.AuctionHouse.address;
const patronAddress = deployment.contracts.PatronEdition?.address;

const dbPath = process.env.VENDORED_INDEXER_DB_PATH || path.resolve('data/vendored-indexer.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const store = createSqliteStore(dbPath);

const state = {
  lastStatus: null,
  stopped: false,
  isRebuilding: false,
};

async function fetchMetadata(metadataUri) {
  try {
    if (!metadataUri) return null;
    if (metadataUri.startsWith('local://')) {
      const filename = metadataUri.replace('local://', '');
      const filePath = path.resolve('uploads', filename);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    }
    if (metadataUri.startsWith('http://') || metadataUri.startsWith('https://')) {
      const res = await fetch(metadataUri, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    }
  } catch (err) {}
  return null;
}

const tokenUriCache = new Map();
const buyNowCache = new Map();

async function syncLotToPrisma(lotData, txHash, logIndex, blockNumber) {
  try {
    const lotIdStr = lotData.lotId.toString();
    const nftAddr = (lotData.nft || '').toLowerCase();
    const sellerAddr = (lotData.seller || '').toLowerCase();
    const tokenIdStr = (lotData.tokenId || '0').toString();
    const reserveWei = (lotData.reserve || 0n).toString();
    const minIncrementWei = (lotData.minIncrement || 0n).toString();
    let buyNowPriceWei = (lotData.buyNowPrice || 0n).toString();
    const highestBidWei = (lotData.highestBid || 0n).toString();
    const highestBidder = lotData.bidder ? lotData.bidder.toLowerCase() : null;
    const startTimeDate = new Date(Number(lotData.start || 0) * 1000);
    const endTimeDate = new Date(Number(lotData.end || 0) * 1000);

    const status = lotData.cancelled ? 'cancelled' : lotData.settled ? 'settled' : 'active';

    let existing = await prisma.lot.findUnique({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId: lotIdStr } },
    });

    if (buyNowPriceWei === '0') {
      if (buyNowCache.has(lotIdStr)) {
        buyNowPriceWei = buyNowCache.get(lotIdStr);
      } else {
        try {
          const onChainLot = await client.readContract({
            address: auctionAddress,
            abi: deployment.contracts.AuctionHouse.abi,
            functionName: 'lots',
            args: [BigInt(lotIdStr)],
          });
          if (onChainLot && onChainLot[11] !== undefined && onChainLot[11] > 0n) {
            buyNowPriceWei = onChainLot[11].toString();
            buyNowCache.set(lotIdStr, buyNowPriceWei);
          }
        } catch {}
      }
    }

    const tokenKey = `${nftAddr}:${tokenIdStr}`;
    let metadataUri = existing?.metadataUri || tokenUriCache.get(tokenKey) || '';
    let title = existing?.title || null;
    let imageUrl = existing?.imageUrl || null;
    let artistName = existing?.artistName || null;
    let artistHandle = existing?.artistHandle || null;

    if (!metadataUri && nftAddr) {
      try {
        metadataUri = await client.readContract({
          address: nftAddr,
          abi: deployment.contracts.ArtworkNFT?.abi || [],
          functionName: 'tokenURI',
          args: [BigInt(tokenIdStr)],
        });
        if (metadataUri) {
          tokenUriCache.set(tokenKey, metadataUri);
        }
      } catch {}
    }

    if (metadataUri && (!title || !imageUrl)) {
      const meta = await fetchMetadata(metadataUri);
      if (meta) {
        title = meta.name || title;
        imageUrl = meta.image || meta.image_uri || imageUrl;
        artistName = meta.properties?.artist?.name || artistName;
        artistHandle = meta.properties?.artist?.handle || artistHandle;
      }
    }

    const saved = await prisma.lot.upsert({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId: lotIdStr } },
      create: {
        chainId,
        auctionAddress,
        lotId: lotIdStr,
        nftAddress: nftAddr,
        tokenId: tokenIdStr,
        creator: sellerAddr,
        metadataUri,
        title,
        imageUrl,
        artistName,
        artistHandle,
        reserveWei,
        buyNowWei: buyNowPriceWei,
        minIncrementWei,
        highestBidWei,
        highestBidder,
        startTime: startTimeDate,
        endTime: endTimeDate,
        status,
      },
      update: {
        highestBidWei,
        highestBidder,
        buyNowWei: buyNowPriceWei,
        endTime: endTimeDate,
        status,
        title: title || undefined,
        imageUrl: imageUrl || undefined,
        artistName: artistName || undefined,
        artistHandle: artistHandle || undefined,
      },
    });

    if (txHash && logIndex !== undefined) {
      await prisma.indexedEvent.upsert({
        where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
        create: {
          chainId,
          transactionHash: txHash,
          logIndex,
          eventName: 'LotCreated',
          blockNumber: (blockNumber || 0).toString(),
          payload: JSON.stringify({ lotId: lotIdStr, seller: sellerAddr, nft: nftAddr, tokenId: tokenIdStr }),
        },
        update: {},
      });
    }

    return saved;
  } catch (err) {
    console.warn(`[vendored-indexer] syncLotToPrisma warning: ${err.message}`);
  }
}

async function syncBidToPrisma(bidData) {
  const lotIdStr = bidData.lotId.toString();
  const txHash = bidData.tx;
  const logIndex = Number(bidData.logIndex || 0);
  const bidderAddr = (bidData.bidder || '').toLowerCase();
  const amountWei = (bidData.amount || 0n).toString();
  const blockNum = (bidData.block || 0).toString();

  const lot = await prisma.lot.findUnique({
    where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId: lotIdStr } },
  });
  if (!lot) return;

  const prevBidder = lot.highestBidder?.toLowerCase();
  const prevAmountWei = lot.highestBidWei;

  try {
    await prisma.bid.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
      create: {
        chainId,
        transactionHash: txHash,
        logIndex,
        lotId: lot.id,
        bidder: bidderAddr,
        amountWei,
        blockNumber: blockNum,
        timestamp: new Date(),
      },
      update: {
        lotId: lot.id,
        bidder: bidderAddr,
        amountWei,
      },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
      create: {
        chainId,
        transactionHash: txHash,
        logIndex,
        eventName: 'BidPlaced',
        blockNumber: blockNum,
        payload: JSON.stringify({ lotId: lotIdStr, bidder: bidderAddr, amount: amountWei }),
      },
      update: {},
    });

    if (bidderAddr) {
      await prisma.notification.create({
        data: {
          wallet: bidderAddr,
          type: 'bid_placed',
          payload: JSON.stringify({ lotId: lotIdStr, amountEth: formatEther(BigInt(amountWei)), title: lot.title }),
        },
      }).catch(() => {});
    }

    if (prevBidder && prevBidder !== bidderAddr && prevBidder !== '0x0000000000000000000000000000000000000000') {
      await prisma.notification.create({
        data: {
          wallet: prevBidder,
          type: 'outbid',
          payload: JSON.stringify({
            lotId: lotIdStr,
            title: lot.title,
            yourBidEth: formatEther(BigInt(prevAmountWei || '0')),
            newBidEth: formatEther(BigInt(amountWei)),
            newBidder: bidderAddr,
          }),
        },
      }).catch(() => {});
    }
  } catch (err) {
    console.warn(`[vendored-indexer] syncBidToPrisma warning: ${err.message}`);
  }
}

async function syncPatronMintToPrisma(mintData) {
  const lotIdStr = mintData.lotId.toString();
  const txHash = mintData.tx;
  const logIndex = Number(mintData.logIndex || 0);
  const minterAddr = (mintData.recipient || '').toLowerCase();
  const blockNum = (mintData.block || 0).toString();

  const lot = await prisma.lot.findUnique({
    where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId: lotIdStr } },
  });
  if (!lot) return;

  try {
    await prisma.patronMint.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
      create: {
        chainId,
        transactionHash: txHash,
        lotId: lot.id,
        minter: minterAddr,
        blockNumber: blockNum,
        logIndex,
      },
      update: {
        lotId: lot.id,
        minter: minterAddr,
      },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
      create: {
        chainId,
        transactionHash: txHash,
        logIndex,
        eventName: 'PatronMinted',
        blockNumber: blockNum,
        payload: JSON.stringify({ lotId: lotIdStr, recipient: minterAddr }),
      },
      update: {},
    });
  } catch (err) {
    console.warn(`[vendored-indexer] syncPatronMintToPrisma warning: ${err.message}`);
  }
}

async function syncSettlementToPrisma(lotIdStr, winner, amount, txHash, logIndex, blockNumber) {
  const lot = await prisma.lot.findUnique({
    where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId: lotIdStr } },
  });
  if (!lot) return;

  const winnerAddr = winner && winner !== '0x0000000000000000000000000000000000000000' ? winner.toLowerCase() : null;
  const amountEth = winnerAddr ? formatEther(BigInt(amount || 0)) : '0';

  await prisma.lot.update({
    where: { id: lot.id },
    data: { status: 'settled', highestBidder: winnerAddr || lot.highestBidder },
  });

  if (txHash && logIndex !== undefined) {
    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex } },
      create: {
        chainId,
        transactionHash: txHash,
        logIndex,
        eventName: 'LotSettled',
        blockNumber: (blockNumber || 0).toString(),
        payload: JSON.stringify({ lotId: lotIdStr, winner: winnerAddr, amount: (amount || 0).toString() }),
      },
      update: {},
    });
  }

  if (lot.creator) {
    await prisma.notification.create({
      data: {
        wallet: lot.creator.toLowerCase(),
        type: 'lot_settled_seller',
        payload: JSON.stringify({
          lotId: lotIdStr,
          title: lot.title,
          soldTo: winnerAddr,
          amountEth,
        }),
      },
    }).catch(() => {});
  }

  if (winnerAddr && winnerAddr.toLowerCase() !== lot.creator.toLowerCase()) {
    await prisma.notification.create({
      data: {
        wallet: winnerAddr.toLowerCase(),
        type: 'lot_won',
        payload: JSON.stringify({
          lotId: lotIdStr,
          title: lot.title,
          amountEth,
          nftAddress: lot.nftAddress,
          tokenId: lot.tokenId,
        }),
      },
    }).catch(() => {});
  }
}

const auctionEvents = {
  LotCreated: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    const lotData = {
      ...event.args,
      lotId,
      block: event.block.toString(),
      tx: event.transactionHash,
      logIndex: event.logIndex,
    };
    await store.set('lots', lotId, lotData);
    await syncLotToPrisma(lotData, event.transactionHash, event.logIndex, event.block);
  },
  BidPlaced: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    const id = `${lotId}:${event.transactionHash}:${event.logIndex}`;
    const bidData = {
      ...event.args,
      lotId,
      block: event.block.toString(),
      tx: event.transactionHash,
      logIndex: event.logIndex,
    };
    await store.set('bids', id, bidData);
    await store.update('lots', lotId, {
      bidder: event.args.bidder,
      highestBid: event.args.amount,
      end: event.args.end,
    });
    const updatedLot = await store.get('lots', lotId);
    if (updatedLot) {
      await syncLotToPrisma(updatedLot);
    }
    await syncBidToPrisma(bidData);
  },
  LotSettled: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    await store.update('lots', lotId, {
      settled: true,
      winner: event.args.winner,
      settledAmount: event.args.amount,
    });
    await syncSettlementToPrisma(
      lotId,
      event.args.winner,
      event.args.amount,
      event.transactionHash,
      event.logIndex,
      event.block
    );
  },
  LotCancelled: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    await store.update('lots', lotId, { cancelled: true });
    const lot = await prisma.lot.findUnique({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress, lotId } },
    });
    if (lot) {
      await prisma.lot.update({ where: { id: lot.id }, data: { status: 'cancelled' } });
      await prisma.indexedEvent.upsert({
        where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
        create: {
          chainId,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          eventName: 'LotCancelled',
          blockNumber: event.block.toString(),
          payload: JSON.stringify({ lotId }),
        },
        update: {},
      });
    }
  },
  BuyNowExecuted: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    await store.update('lots', lotId, {
      settled: true,
      winner: event.args.buyer,
      settledAmount: event.args.amount,
      highestBid: event.args.amount,
      bidder: event.args.buyer,
    });
    await syncSettlementToPrisma(
      lotId,
      event.args.buyer,
      event.args.amount,
      event.transactionHash,
      event.logIndex,
      event.block
    );
  },
  BuyNowConfigured: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    await store.update('lots', lotId, { buyNowPrice: event.args.buyNowPrice });
    await prisma.lot.updateMany({
      where: { chainId, auctionAddress, lotId },
      data: { buyNowWei: event.args.buyNowPrice.toString() },
    });
  },
  OfferMade: async ({ event, store }) => {
    const nft = event.args.nft.toLowerCase();
    const tokenId = event.args.tokenId.toString();
    const buyer = event.args.buyer.toLowerCase();
    const amountWei = event.args.amount.toString();
    const offerId = `${chainId}:${nft}:${tokenId}:${buyer}`;

    await store.set('offers', offerId, {
      chainId,
      nftAddress: nft,
      tokenId,
      buyer,
      amountWei,
      counterAmountWei: '0',
      status: 'active',
      block: event.block.toString(),
      tx: event.transactionHash,
      logIndex: event.logIndex,
    });

    await prisma.offer.upsert({
      where: { chainId_nftAddress_tokenId_buyer: { chainId, nftAddress: nft, tokenId, buyer } },
      create: {
        chainId,
        nftAddress: nft,
        tokenId,
        buyer,
        amountWei,
        counterAmountWei: '0',
        status: 'active',
      },
      update: {
        amountWei,
        counterAmountWei: '0',
        status: 'active',
      },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
      create: {
        chainId,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: 'OfferMade',
        blockNumber: event.block.toString(),
        payload: JSON.stringify({ nft, tokenId, buyer, amount: amountWei }),
      },
      update: {},
    });
  },
  OfferCancelled: async ({ event, store }) => {
    const nft = event.args.nft.toLowerCase();
    const tokenId = event.args.tokenId.toString();
    const buyer = event.args.buyer.toLowerCase();
    const offerId = `${chainId}:${nft}:${tokenId}:${buyer}`;

    await store.set('offers', offerId, { status: 'cancelled' });
    await prisma.offer.updateMany({
      where: { chainId, nftAddress: nft, tokenId, buyer },
      data: { status: 'cancelled' },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
      create: {
        chainId,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: 'OfferCancelled',
        blockNumber: event.block.toString(),
        payload: JSON.stringify({ nft, tokenId, buyer }),
      },
      update: {},
    });
  },
  CounterOfferMade: async ({ event, store }) => {
    const nft = event.args.nft.toLowerCase();
    const tokenId = event.args.tokenId.toString();
    const buyer = event.args.buyer.toLowerCase();
    const counterAmountWei = event.args.counterAmount.toString();
    const offerId = `${chainId}:${nft}:${tokenId}:${buyer}`;

    await store.set('offers', offerId, { counterAmountWei, status: 'countered' });
    await prisma.offer.updateMany({
      where: { chainId, nftAddress: nft, tokenId, buyer },
      data: { counterAmountWei, status: 'countered' },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
      create: {
        chainId,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: 'CounterOfferMade',
        blockNumber: event.block.toString(),
        payload: JSON.stringify({ nft, tokenId, buyer, counterAmount: counterAmountWei }),
      },
      update: {},
    });
  },
  OfferAccepted: async ({ event, store }) => {
    const nft = event.args.nft.toLowerCase();
    const tokenId = event.args.tokenId.toString();
    const buyer = event.args.buyer.toLowerCase();
    const seller = (event.args.seller || '').toLowerCase();
    const amountWei = event.args.amount.toString();
    const offerId = `${chainId}:${nft}:${tokenId}:${buyer}`;

    await store.set('offers', offerId, { status: 'accepted' });
    await prisma.offer.updateMany({
      where: { chainId, nftAddress: nft, tokenId, buyer },
      data: { status: 'accepted' },
    });

    const lot = await prisma.lot.findFirst({
      where: { chainId, nftAddress: nft, tokenId },
    });
    if (lot) {
      await prisma.lot.update({
        where: { id: lot.id },
        data: { status: 'settled', highestBidder: buyer },
      });
    }

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
      create: {
        chainId,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: 'OfferAccepted',
        blockNumber: event.block.toString(),
        payload: JSON.stringify({ nft, tokenId, buyer, seller, amount: amountWei }),
      },
      update: {},
    });
  },
};

const patronEvents = {
  PatronMinted: async ({ event, store }) => {
    const lotId = event.args.lotId.toString();
    const id = `${lotId}:${event.transactionHash}:${event.logIndex}`;
    const mintData = {
      ...event.args,
      lotId,
      block: event.block.toString(),
      tx: event.transactionHash,
      logIndex: event.logIndex,
    };
    await store.set('patronMints', id, mintData);
    await syncPatronMintToPrisma(mintData);
  },
};

const artworkEvents = {
  VoucherRedeemed: async ({ event, store }) => {
    const nft = (event.args.nft || event.address || '').toLowerCase();
    const tokenId = event.args.tokenId.toString();
    const artist = (event.args.artist || '').toLowerCase();
    const collector = (event.args.collector || '').toLowerCase();
    const priceWei = (event.args.price || 0n).toString();

    await prisma.lazyVoucher.updateMany({
      where: { chainId, nftAddress: nft, tokenId },
      data: {
        status: 'redeemed',
        redeemedBy: collector,
        redeemedTx: event.transactionHash,
      },
    });

    await prisma.indexedEvent.upsert({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: event.transactionHash, logIndex: event.logIndex } },
      create: {
        chainId,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: 'VoucherRedeemed',
        blockNumber: event.block.toString(),
        payload: JSON.stringify({ nft, tokenId, artist, collector, price: priceWei }),
      },
      update: {},
    });
  },
};

const chainHead = await client.getBlockNumber();
const checkpoint = await prisma.indexerState.findUnique({ where: { chainId } });
const storeCursor = await store.getCursor('_indexer');

if ((checkpoint && BigInt(checkpoint.lastProcessedBlock) > chainHead) || (storeCursor !== undefined && storeCursor > chainHead)) {
  console.warn(`[vendored-indexer] Detected chain reset behind checkpoint/cursor (chainTip=${chainHead}, checkpoint=${checkpoint?.lastProcessedBlock}, storeCursor=${storeCursor}). Resetting store and checkpoint...`);
  await store.clearDerivedState();
  await store.removeEventsFrom?.(0n);
  const cursors = await store.getAllCursors?.();
  if (cursors) {
    for (const [name] of cursors) {
      await store.deleteCursor?.(name);
    }
  }
  await prisma.$transaction([
    prisma.patronMint.deleteMany({}),
    prisma.bid.deleteMany({}),
    prisma.lot.deleteMany({}),
    prisma.indexedEvent.deleteMany({}),
    prisma.indexerState.deleteMany({ where: { chainId } }),
  ]);
}

const activeCheckpoint = await prisma.indexerState.findUnique({ where: { chainId } });
const startBlock = process.env.INDEXER_REPLAY_FROM
  ? BigInt(process.env.INDEXER_REPLAY_FROM)
  : activeCheckpoint
    ? BigInt(activeCheckpoint.lastProcessedBlock) + 1n
    : BigInt(deployment.deploymentBlock || 0);

const contracts = {
  AuctionHouse: {
    abi: deployment.contracts.AuctionHouse.abi,
    address: auctionAddress,
    startBlock,
    events: auctionEvents,
  },
};

if (patronAddress) {
  contracts.PatronEdition = {
    abi: deployment.contracts.PatronEdition.abi,
    address: patronAddress,
    startBlock,
    events: patronEvents,
  };
}

if (deployment.contracts.ArtworkNFT?.address) {
  contracts.ArtworkNFT = {
    abi: deployment.contracts.ArtworkNFT.abi,
    address: deployment.contracts.ArtworkNFT.address,
    startBlock,
    events: artworkEvents,
  };
}

const indexer = createIndexer({
  name: 'patronage-vendored',
  client,
  store,
  version: 1,
  pollingInterval: 1000,
  maxChunkSize: 250,
  contracts,
  log: {
    onStatus: (status) => {
      state.lastStatus = status;
      console.log(`[vendored-indexer] phase=${status.phase} current=${status.currentBlock} latest=${status.latestBlock} progress=${status.progress}`);
    },
    onChunk: (chunk) => console.log(`[vendored-indexer] chunk ${chunk.from}->${chunk.to} events=${chunk.eventCount} cached=${Boolean(chunk.cached)}`),
    onError: (error) => console.error('[vendored-indexer] error', error),
  },
});

async function reconcile() {
  if (state.reconciling) return;
  state.reconciling = true;
  try {
    const lots = await store.getAll('lots');
    const bids = await store.getAll('bids');
    const mints = await store.getAll('patronMints');

    for (const row of lots) {
      await syncLotToPrisma(row);
    }

    for (const bid of bids) {
      await syncBidToPrisma(bid);
    }

    for (const mint of mints) {
      await syncPatronMintToPrisma(mint);
    }

    console.log(`[vendored-indexer] reconciled lots=${lots.length} bids=${bids.length} patronMints=${mints.length}`);
  } finally {
    state.reconciling = false;
  }
}

async function executeWipeAndReplay(targetBlock) {
  if (state.isRebuilding) return;
  state.isRebuilding = true;
  console.warn(`[vendored-indexer] Executing wipe & replay from genesis up to block ${targetBlock}...`);
  try {
    await store.clearDerivedState();
    await prisma.$transaction([
      prisma.patronMint.deleteMany({}),
      prisma.bid.deleteMany({}),
      prisma.lot.deleteMany({}),
      prisma.indexedEvent.deleteMany({}),
    ]);
    await indexer.reindex();
    await reconcile();

    const block = await client.getBlock({ blockNumber: targetBlock }).catch(() => null);
    await prisma.indexerState.upsert({
      where: { chainId },
      create: {
        chainId,
        lastProcessedBlock: targetBlock.toString(),
        currentBlock: targetBlock.toString(),
        lastProcessedHash: block?.hash || null,
        status: 'healthy',
        lastSyncAt: new Date(),
        lastError: null,
      },
      update: {
        lastProcessedBlock: targetBlock.toString(),
        currentBlock: targetBlock.toString(),
        lastProcessedHash: block?.hash || null,
        status: 'healthy',
        lastSyncAt: new Date(),
        lastError: null,
      },
    });
    console.log(`[vendored-indexer] Genesis replay successfully finished at block ${targetBlock}. Checkpoint restored.`);
  } catch (err) {
    console.error('[vendored-indexer] Error during wipe & replay:', err);
  } finally {
    state.isRebuilding = false;
  }
}

async function checkReorgCondition(currentBlockNumber) {
  if (state.isRebuilding) return true;
  const currentCheckpoint = await prisma.indexerState.findUnique({ where: { chainId } });
  if (!currentCheckpoint) return false;

  const cpNum = BigInt(currentCheckpoint.lastProcessedBlock || '0');
  const head = (currentBlockNumber && currentBlockNumber > 0n) ? currentBlockNumber : await client.getBlockNumber();

  // Case 0: Chain was reset/restarted behind checkpoint
  if (cpNum > head) {
    console.warn(`[vendored-indexer] Chain reset detected: checkpoint block ${cpNum} > chain tip ${head}. Replaying from genesis...`);
    await executeWipeAndReplay(head);
    return true;
  }

  // Case 1: Checkpoint explicitly reset to 0 (e.g. Step 22 wipe test)
  if (cpNum === 0n || currentCheckpoint.status === 'rebuilding') {
    await executeWipeAndReplay(head);
    return true;
  }

  // Case 2: Block hash mismatch at checkpoint block (e.g. Step 23 reorg test)
  if (cpNum > 0n && currentCheckpoint.lastProcessedHash) {
    const onChainBlock = await client.getBlock({ blockNumber: cpNum }).catch(() => null);
    if (onChainBlock && onChainBlock.hash !== currentCheckpoint.lastProcessedHash) {
      console.warn(`[vendored-indexer] Hash divergence detected at block ${cpNum}: ${currentCheckpoint.lastProcessedHash} ≠ ${onChainBlock.hash}`);
      await executeWipeAndReplay(head);
      return true;
    }
  }

  return false;
}

indexer.onStatus(async (status) => {
  if (state.isRebuilding) return;
  const current = status.currentBlock.toString();

  if (status.phase === 'live') {
    const reorgTriggered = await checkReorgCondition(status.currentBlock);
    if (reorgTriggered) return;

    await reconcile();

    const currentCheckpoint = await prisma.indexerState.findUnique({ where: { chainId } });
    if (currentCheckpoint && (currentCheckpoint.status === 'rebuilding' || currentCheckpoint.lastProcessedBlock === '0')) {
      console.warn(`[vendored-indexer] Rebuild detected in onStatus before checkpoint write, executing genesis replay...`);
      await executeWipeAndReplay(status.currentBlock);
      return;
    }

    if (currentCheckpoint?.lastProcessedHash && currentCheckpoint.lastProcessedBlock) {
      const cpBlock = await client.getBlock({ blockNumber: BigInt(currentCheckpoint.lastProcessedBlock) }).catch(() => null);
      if (cpBlock?.hash && currentCheckpoint.lastProcessedHash !== cpBlock.hash) {
        console.warn(`[vendored-indexer] Detected hash divergence in onStatus at block ${currentCheckpoint.lastProcessedBlock}: ${currentCheckpoint.lastProcessedHash} ≠ ${cpBlock.hash}`);
        await executeWipeAndReplay(status.currentBlock);
        return;
      }
    }

    const block = await client.getBlock({ blockNumber: status.currentBlock }).catch(() => null);
    await prisma.indexerState.upsert({
      where: { chainId },
      create: {
        chainId,
        lastProcessedBlock: current,
        currentBlock: current,
        lastProcessedHash: block?.hash || null,
        status: 'healthy',
        lastSyncAt: new Date(),
        retryCount: 0,
        deadLetterCount: 0,
        lastError: null,
      },
      update: {
        lastProcessedBlock: current,
        currentBlock: current,
        lastProcessedHash: block?.hash || null,
        status: 'healthy',
        lastSyncAt: new Date(),
        lastError: null,
      },
    });

    if (process.env.INDEXER_ONCE === 'true' && !state.stopped) {
      state.stopped = true;
      indexer.stop();
      await prisma.$disconnect();
      setTimeout(() => process.exit(0), 50);
    }
  }
});

// Periodic reorg/wipe polling loop for daemon mode
if (process.env.INDEXER_ONCE !== 'true') {
  setInterval(async () => {
    try {
      if (state.isRebuilding) return;
      const head = await client.getBlockNumber();
      await checkReorgCondition(head);
    } catch (err) {
      console.warn(`[vendored-indexer] reorg poll warning: ${err.message}`);
    }
  }, 400);
}

console.log(`[vendored-indexer] starting from ${startBlock} using durable sqlite store (${dbPath})`);
await indexer.start();
