import fs from 'node:fs';
import path from 'node:path';
import '../../src/config/load-env.mjs';
import { createPublicClient, http, formatEther, parseAbiItem } from 'viem';
import { mainnet, sepolia, base, baseSepolia, foundry } from 'viem/chains';
import { PrismaClient } from '@prisma/client';

const CHAIN_MAP = {
  1: mainnet,
  11155111: sepolia,
  8453: base,
  84532: baseSepolia,
  31337: foundry,
};

const prisma = new PrismaClient();
const activeChainId = Number(process.env.CHAIN_ID || 31337);
const activeChain = CHAIN_MAP[activeChainId] || foundry;
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

const metrics = {
  status: 'starting',
  retryCount: 0,
  deadLetterCount: 0,
  lastError: null,
  startedAt: new Date(),
};

function loadDeployment() {
  const targetChain = process.env.CHAIN_ID || '31337';
  let deploymentPath = path.resolve('contracts', 'deployments', `${targetChain}.json`);
  if (!fs.existsSync(deploymentPath)) {
    deploymentPath = path.resolve('contracts', 'deployments', '31337.json');
  }
  if (!fs.existsSync(deploymentPath)) {
    const all = fs.existsSync(path.resolve('contracts', 'deployments'))
      ? fs.readdirSync(path.resolve('contracts', 'deployments')).filter((f) => f.endsWith('.json'))
      : [];
    if (all.length > 0) deploymentPath = path.resolve('contracts', 'deployments', all[0]);
  }
  if (!fs.existsSync(deploymentPath)) {
    console.warn(`[indexer] Deployment manifest not found. Waiting for deployment...`);
    return null;
  }
  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
}

async function fetchMetadata(metadataUri) {
  try {
    if (metadataUri.startsWith('http://') || metadataUri.startsWith('https://')) {
      const res = await fetch(metadataUri);
      if (res.ok) return await res.json();
    }
  } catch (err) {
    console.warn(`[indexer] Could not fetch metadata URI ${metadataUri}:`, err.message);
  }
  return null;
}

async function syncEvents() {
  const deployment = loadDeployment();
  if (!deployment) return;

  const chainId = deployment.chainId || 31337;
  const auctionHouseAddr = deployment.contracts.AuctionHouse?.address;
  const artistFactoryAddr = deployment.contracts.ArtistFactory?.address;
  const patronEditionAddr = deployment.contracts.PatronEdition?.address;

  if (!auctionHouseAddr) return;

  const currentBlock = await client.getBlockNumber();

  let checkpoint = await prisma.indexerState.findUnique({ where: { chainId } });
  metrics.status = 'syncing';
  metrics.currentBlock = currentBlock.toString();

  // A checkpoint hash mismatch means the local chain was reset or reorganized.
  // Indexed tables are derived state, so the safe recovery is to clear them and
  // replay all contract events from the deployment boundary.
  if (checkpoint && BigInt(checkpoint.lastProcessedBlock) > 0n) {
    const checkpointNumber = BigInt(checkpoint.lastProcessedBlock);
    let checkpointBlock = null;
    if (checkpointNumber <= currentBlock) {
      checkpointBlock = await client.getBlock({ blockNumber: checkpointNumber });
    }
    if (checkpointNumber > currentBlock || (checkpoint.lastProcessedHash && checkpointBlock?.hash !== checkpoint.lastProcessedHash)) {
      console.warn(`[indexer] Checkpoint reorg detected at block ${checkpoint.lastProcessedBlock}; rebuilding derived state.`);
      await prisma.$transaction([
        prisma.patronMint.deleteMany({}),
        prisma.bid.deleteMany({}),
        prisma.lot.deleteMany({}),
        prisma.indexedEvent.deleteMany({}),
        prisma.indexerState.update({
          where: { chainId },
          data: { lastProcessedBlock: '0', lastProcessedHash: null, status: 'rebuilding', lastError: null },
        }),
      ]);
      metrics.status = 'rebuilding';
      // Force the replay boundary below to replay from block zero for this sync cycle.
      checkpoint = { lastProcessedBlock: '0' };
    }
  }
  const replayFrom = process.env.INDEXER_REPLAY_FROM ? BigInt(process.env.INDEXER_REPLAY_FROM) : null;
  const fromBlock = replayFrom ?? (checkpoint ? BigInt(checkpoint.lastProcessedBlock) + 1n : BigInt(deployment.deploymentBlock || 0n));
  console.log(`[indexer] sync range from=${fromBlock} to=${currentBlock} source=${replayFrom !== null ? 'configured-replay' : (checkpoint ? 'checkpoint' : 'deployment')}`);

  if (fromBlock > currentBlock) {
    return; // Already up to date
  }

  // 1. AuctionHouse Events
  const lotCreatedLogs = await client.getLogs({
    address: auctionHouseAddr,
    event: parseAbiItem('event LotCreated(uint256 indexed lotId, address indexed seller, address indexed nft, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint64 start, uint64 end)'),
    fromBlock,
    toBlock: currentBlock,
  });

  for (const log of lotCreatedLogs) {
    const { lotId, seller, nft, tokenId, reserve, start, end } = log.args;
    const txHash = log.transactionHash;
    const logIdx = log.logIndex;
    const blockNum = log.blockNumber.toString();

    // Reentrancy / Idempotency check
    const existingEvent = await prisma.indexedEvent.findUnique({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
    });
    if (existingEvent) continue;

    // Fetch token URI from NFT contract if possible
    let metadataUri = '';
    try {
      metadataUri = await client.readContract({
        address: nft,
        abi: deployment.contracts.ArtworkNFT?.abi || [],
        functionName: 'tokenURI',
        args: [tokenId],
      });
    } catch {}

    let buyNowPriceWei = '0';
    try {
      const lotData = await client.readContract({
        address: auctionHouseAddr,
        abi: [
          {
            inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
            name: 'lots',
            outputs: [
              { internalType: 'address', name: 'seller', type: 'address' },
              { internalType: 'address', name: 'nft', type: 'address' },
              { internalType: 'bool', name: 'settled', type: 'bool' },
              { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
              { internalType: 'uint256', name: 'reserve', type: 'uint256' },
              { internalType: 'uint256', name: 'minIncrement', type: 'uint256' },
              { internalType: 'uint256', name: 'highestBid', type: 'uint256' },
              { internalType: 'address', name: 'highestBidder', type: 'address' },
              { internalType: 'uint64', name: 'start', type: 'uint64' },
              { internalType: 'uint64', name: 'end', type: 'uint64' },
              { internalType: 'uint64', name: 'lastBidTime', type: 'uint64' },
              { internalType: 'uint256', name: 'buyNowPrice', type: 'uint256' },
            ],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        functionName: 'lots',
        args: [lotId],
      });
      if (lotData && lotData[11] !== undefined && lotData[11] > 0n) {
        buyNowPriceWei = lotData[11].toString();
      }
    } catch {}

    const meta = await fetchMetadata(metadataUri);

    const lotIdStr = lotId.toString();
    const startTimeDate = new Date(Number(start) * 1000);
    const endTimeDate = new Date(Number(end) * 1000);

    const title = meta?.name || null;
    const imageUrl = meta?.image || meta?.image_uri || null;
    const artistName = meta?.properties?.artist?.name || null;
    const artistHandle = meta?.properties?.artist?.handle || null;

    // Atomic transaction for LotCreated
    await prisma.$transaction([
      prisma.lot.upsert({
        where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr } },
        create: {
          chainId,
          auctionAddress: auctionHouseAddr,
          lotId: lotIdStr,
          nftAddress: nft,
          tokenId: tokenId.toString(),
          creator: seller,
          metadataUri,
          title,
          imageUrl,
          artistName,
          artistHandle,
          reserveWei: reserve.toString(),
          buyNowWei: buyNowPriceWei,
          minIncrementWei: log.args.minIncrement.toString(),
          highestBidWei: '0',
          startTime: startTimeDate,
          endTime: endTimeDate,
          status: 'active',
        },
        update: {
          startTime: startTimeDate,
          endTime: endTimeDate,
          buyNowWei: buyNowPriceWei,
          status: 'active',
        },
      }),
      prisma.indexedEvent.create({
        data: {
          chainId,
          transactionHash: txHash,
          logIndex: logIdx,
          eventName: 'LotCreated',
          blockNumber: blockNum,
          payload: JSON.stringify({ lotId: lotIdStr, seller, nft, tokenId: tokenId.toString(), buyNowWei: buyNowPriceWei }),
        },
      }),
    ]);
  }

  // 2. BidPlaced Logs
  const bidPlacedLogs = await client.getLogs({
    address: auctionHouseAddr,
    event: parseAbiItem('event BidPlaced(uint256 indexed lotId, address indexed bidder, uint256 amount, uint64 end)'),
    fromBlock,
    toBlock: currentBlock,
  });

  for (const log of bidPlacedLogs) {
    const { lotId, bidder, amount, end } = log.args;
    const txHash = log.transactionHash;
    const logIdx = log.logIndex;
    const blockNum = log.blockNumber.toString();

    const existingEvent = await prisma.indexedEvent.findUnique({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
    });
    if (existingEvent) continue;

    const lotIdStr = lotId.toString();

    const lot = await prisma.lot.findUnique({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr } },
    });

    if (lot) {
      const prevBidder = lot.highestBidder;
      const prevAmountWei = lot.highestBidWei;

      // Atomic transaction for BidPlaced
      const ops = [
        prisma.bid.create({
          data: {
            chainId,
            transactionHash: txHash,
            logIndex: logIdx,
            lotId: lot.id,
            bidder,
            amountWei: amount.toString(),
            blockNumber: blockNum,
            timestamp: new Date(),
          },
        }),
        prisma.lot.update({
          where: { id: lot.id },
          data: {
            highestBidWei: amount.toString(),
            highestBidder: bidder,
            endTime: new Date(Number(end) * 1000),
          },
        }),
        // New bidder confirmation
        prisma.notification.create({
          data: {
            wallet: bidder,
            type: 'bid_placed',
            payload: JSON.stringify({ lotId: lotIdStr, amountEth: formatEther(amount), title: lot.title }),
          },
        }),
        prisma.indexedEvent.create({
          data: {
            chainId,
            transactionHash: txHash,
            logIndex: logIdx,
            eventName: 'BidPlaced',
            blockNumber: blockNum,
            payload: JSON.stringify({ lotId: lotIdStr, bidder, amount: amount.toString() }),
          },
        }),
      ];

      // Outbid notification for displaced bidder
      if (prevBidder && prevBidder !== bidder && prevBidder !== '0x0000000000000000000000000000000000000000') {
        ops.push(
          prisma.notification.create({
            data: {
              wallet: prevBidder.toLowerCase(),
              type: 'outbid',
              payload: JSON.stringify({
                lotId: lotIdStr,
                title: lot.title,
                yourBidEth: formatEther(BigInt(prevAmountWei || '0')),
                newBidEth: formatEther(amount),
                newBidder: bidder,
              }),
            },
          })
        );
      }

      await prisma.$transaction(ops);
    }
  }

  // 3. LotSettled Logs
  const lotSettledLogs = await client.getLogs({
    address: auctionHouseAddr,
    event: parseAbiItem('event LotSettled(uint256 indexed lotId, address indexed winner, uint256 amount, uint256 protocolFee, uint256 royalty)'),
    fromBlock,
    toBlock: currentBlock,
  });

  for (const log of lotSettledLogs) {
    const { lotId, winner, amount } = log.args;
    const txHash = log.transactionHash;
    const logIdx = log.logIndex;
    const blockNum = log.blockNumber.toString();

    const existingEvent = await prisma.indexedEvent.findUnique({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
    });
    if (existingEvent) continue;

    const lotIdStr = lotId.toString();
    const lot = await prisma.lot.findUnique({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr } },
    });

    if (lot) {
      const winnerAddr = winner && winner !== '0x0000000000000000000000000000000000000000' ? winner : null;
      const amountEth = winnerAddr ? formatEther(amount) : '0';

      // Atomic transaction for LotSettled
      const ops = [
        prisma.lot.update({
          where: { id: lot.id },
          data: { status: 'settled' },
        }),
        prisma.indexedEvent.create({
          data: {
            chainId,
            transactionHash: txHash,
            logIndex: logIdx,
            eventName: 'LotSettled',
            blockNumber: blockNum,
            payload: JSON.stringify({ lotId: lotIdStr, winner, amount: amount.toString() }),
          },
        }),
      ];

      // Notify seller
      ops.push(
        prisma.notification.create({
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
        })
      );

      // Notify winning collector
      if (winnerAddr && winnerAddr.toLowerCase() !== lot.creator.toLowerCase()) {
        ops.push(
          prisma.notification.create({
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
          })
        );
      }

      await prisma.$transaction(ops);
    }
  }

  // 4. LotCancelled Logs
  const lotCancelledLogs = await client.getLogs({
    address: auctionHouseAddr,
    event: parseAbiItem('event LotCancelled(uint256 indexed lotId)'),
    fromBlock,
    toBlock: currentBlock,
  });

  for (const log of lotCancelledLogs) {
    const { lotId } = log.args;
    const txHash = log.transactionHash;
    const logIdx = log.logIndex;
    const blockNum = log.blockNumber.toString();

    const existingEvent = await prisma.indexedEvent.findUnique({
      where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
    });
    if (existingEvent) continue;

    const lotIdStr = lotId.toString();
    const lot = await prisma.lot.findUnique({
      where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr } },
    });

    if (lot) {
      // Atomic transaction for LotCancelled
      await prisma.$transaction([
        prisma.lot.update({
          where: { id: lot.id },
          data: { status: 'cancelled' },
        }),
        prisma.indexedEvent.create({
          data: {
            chainId,
            transactionHash: txHash,
            logIndex: logIdx,
            eventName: 'LotCancelled',
            blockNumber: blockNum,
            payload: JSON.stringify({ lotId: lotIdStr }),
          },
        }),
      ]);
    }
  }

  // 4b. BuyNowExecuted Logs
  try {
    const buyNowLogs = await client.getLogs({
      address: auctionHouseAddr,
      event: parseAbiItem('event BuyNowExecuted(uint256 indexed lotId, address indexed buyer, uint256 amount)'),
      fromBlock,
      toBlock: currentBlock,
    });

    for (const log of buyNowLogs) {
      const { lotId, buyer, amount } = log.args;
      const txHash = log.transactionHash;
      const logIdx = log.logIndex;
      const blockNum = log.blockNumber.toString();

      const existingEvent = await prisma.indexedEvent.findUnique({
        where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
      });
      if (existingEvent) continue;

      const lotIdStr = lotId.toString();
      const lot = await prisma.lot.findUnique({
        where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr } },
      });

      if (lot) {
        await prisma.$transaction([
          prisma.lot.update({
            where: { id: lot.id },
            data: { status: 'settled', highestBidder: buyer, highestBidWei: amount.toString() },
          }),
          prisma.indexedEvent.create({
            data: {
              chainId,
              transactionHash: txHash,
              logIndex: logIdx,
              eventName: 'BuyNowExecuted',
              blockNumber: blockNum,
              payload: JSON.stringify({ lotId: lotIdStr, buyer, amount: amount.toString() }),
            },
          }),
          prisma.notification.create({
            data: {
              wallet: buyer,
              type: 'buy_now_executed',
              payload: JSON.stringify({ lotId: lotIdStr, amountEth: formatEther(amount), title: lot.title }),
            },
          }),
        ]);
      }
    }
  } catch {}

  // 4c. BuyNowConfigured Logs
  try {
    const buyNowConfigLogs = await client.getLogs({
      address: auctionHouseAddr,
      event: parseAbiItem('event BuyNowConfigured(uint256 indexed lotId, uint256 buyNowPrice)'),
      fromBlock,
      toBlock: currentBlock,
    });

    for (const log of buyNowConfigLogs) {
      const { lotId, buyNowPrice } = log.args;
      const lotIdStr = lotId.toString();
      await prisma.lot.updateMany({
        where: { chainId, auctionAddress: auctionHouseAddr, lotId: lotIdStr },
        data: { buyNowWei: buyNowPrice.toString() },
      });
    }
  } catch {}

  // 5. PatronEdition mints
  if (patronEditionAddr) {
    const patronMintLogs = await client.getLogs({
      address: patronEditionAddr,
      event: parseAbiItem('event PatronMinted(uint256 indexed lotId, address indexed recipient)'),
      fromBlock,
      toBlock: currentBlock,
    });

    for (const log of patronMintLogs) {
      const { lotId, recipient } = log.args;
      const txHash = log.transactionHash;
      const logIdx = log.logIndex;
      const blockNum = log.blockNumber.toString();
      const existingEvent = await prisma.indexedEvent.findUnique({
        where: { chainId_transactionHash_logIndex: { chainId, transactionHash: txHash, logIndex: logIdx } },
      });
      if (existingEvent) continue;

      const lot = await prisma.lot.findUnique({
        where: { chainId_auctionAddress_lotId: { chainId, auctionAddress: auctionHouseAddr, lotId: lotId.toString() } },
      });
      if (!lot) continue;

      await prisma.$transaction([
        prisma.patronMint.create({
          data: {
            chainId,
            transactionHash: txHash,
            lotId: lot.id,
            minter: recipient,
            blockNumber: blockNum,
            logIndex: logIdx,
          },
        }),
        prisma.indexedEvent.create({
          data: {
            chainId,
            transactionHash: txHash,
            logIndex: logIdx,
            eventName: 'PatronMinted',
            blockNumber: blockNum,
            payload: JSON.stringify({ lotId: lotId.toString(), recipient }),
          },
        }),
      ]);
    }
  }

  // Metadata may become available after the chain event. Retry unresolved
  // URLs without altering the chain-derived auction state.
  const metadataCandidates = await prisma.lot.findMany({
    where: { metadataUri: { not: '' }, OR: [{ title: null }, { imageUrl: null }] },
    take: 50,
  });
  for (const lot of metadataCandidates) {
    const meta = await fetchMetadata(lot.metadataUri);
    if (!meta) continue;
    await prisma.lot.update({
      where: { id: lot.id },
      data: {
        title: meta.name || lot.title,
        imageUrl: meta.image || meta.image_uri || lot.imageUrl,
        artistName: meta.properties?.artist?.name || lot.artistName,
        artistHandle: meta.properties?.artist?.handle || lot.artistHandle,
      },
    });
  }

  const checkpointBlock = await client.getBlock({ blockNumber: currentBlock });
  await prisma.indexerState.upsert({
    where: { chainId },
    create: {
      chainId,
      lastProcessedBlock: currentBlock.toString(),
      lastProcessedHash: checkpointBlock.hash || null,
      currentBlock: currentBlock.toString(),
      lastSyncAt: new Date(),
      status: 'healthy',
      retryCount: metrics.retryCount,
      deadLetterCount: metrics.deadLetterCount,
      lastError: null,
    },
    update: {
      lastProcessedBlock: currentBlock.toString(),
      lastProcessedHash: checkpointBlock.hash || null,
      currentBlock: currentBlock.toString(),
      lastSyncAt: new Date(),
      status: 'healthy',
      retryCount: metrics.retryCount,
      deadLetterCount: metrics.deadLetterCount,
      lastError: null,
    },
  });
  metrics.status = 'healthy';
  metrics.lastError = null;
}

async function startIndexer() {
  console.log(`[indexer] Starting Patronage Local Indexer on ${rpcUrl}...`);
  while (true) {
    try {
      await syncEvents();
    } catch (err) {
      metrics.status = 'error';
      metrics.retryCount += 1;
      metrics.lastError = err.message || String(err);
      console.error('[indexer] Error during sync:', err.message || err);
      const deployment = loadDeployment();
      if (deployment?.chainId) {
        await prisma.indexerState.upsert({
          where: { chainId: deployment.chainId },
          create: { chainId: deployment.chainId, status: 'error', retryCount: metrics.retryCount, lastError: metrics.lastError },
          update: { status: 'error', retryCount: metrics.retryCount, lastError: metrics.lastError },
        }).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

if (process.env.INDEXER_ONCE === 'true') {
  syncEvents()
    .then(() => prisma.$disconnect())
    .catch((err) => {
      metrics.status = 'error';
      metrics.retryCount += 1;
      console.error('[indexer] One-shot sync failed:', err);
      process.exit(1);
    });
} else {
  startIndexer().catch((err) => {
    console.error('[indexer] Fatal indexer crash:', err);
    process.exit(1);
  });
}
