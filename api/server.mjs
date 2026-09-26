import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { formatEther } from 'viem';
import { createStorageProvider } from '../src/providers/storage.mjs';
import { createPublicClient, http as viemHttp } from 'viem';
import { mainnet, sepolia, base, baseSepolia, foundry } from 'viem/chains';

import {
  generateNonce,
  consumeNonce,
  verifySiweSignature,
  createSession,
  getSession,
  revokeSession,
  createSiweMessage,
  validateSiweMessage,
  pruneExpiredSessionsAndNonces
} from '../src/auth/siwe.mjs';
import { isAddressSanctioned, getSanctionsMetadata } from '../src/auth/sanctions.mjs';
import { syncSanctionsFeed } from '../scripts/sync-sanctions.mjs';

const CHAIN_MAP = {
  1: mainnet,
  11155111: sepolia,
  8453: base,
  84532: baseSepolia,
  31337: foundry,
};

const ADMIN_ADDRESSES = new Set(
  (process.env.ADMIN_ADDRESSES || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
);

const MODERATOR_ADDRESSES = new Set([
  ...ADMIN_ADDRESSES,
  ...(process.env.MODERATOR_ADDRESSES || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
]);

function getSessionRole(address) {
  if (!address) return 'anonymous';
  const norm = address.toLowerCase();
  if (ADMIN_ADDRESSES.has(norm)) return 'admin';
  if (MODERATOR_ADDRESSES.has(norm)) return 'moderator';
  return 'user';
}

const prisma = new PrismaClient();
const storage = createStorageProvider();
const port = Number(process.env.API_PORT || 8787);
const activeChainId = Number(process.env.CHAIN_ID || 31337);
const activeChain = CHAIN_MAP[activeChainId] || foundry;
const rpcClient = createPublicClient({ chain: activeChain, transport: viemHttp(process.env.RPC_URL || 'http://127.0.0.1:8545') });
const SANCTIONS_SYNC_INTERVAL_MS = Number(process.env.SANCTIONS_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000); // 24 hours
let sanctionsSyncTimer = null;
const SESSION_PRUNE_INTERVAL_MS = Number(process.env.SESSION_PRUNE_INTERVAL_MS || 60 * 60 * 1000); // 1 hour
let sessionPruneTimer = null;

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:4173',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    response.end(body);
  } else {
    response.end(JSON.stringify(body));
  }
}

const requestTimes = new Map();
function rateLimit(request, response) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (requestTimes.get(key) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 120) { send(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }); return false; }
  recent.push(now); requestTimes.set(key, recent); return true;
}

async function sessionFromRequest(request) {
  const value = request.headers.authorization || '';
  const token = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (!token) return null;
  return await getSession(token);
}

async function rejectUnauthorized(request, response) {
  const session = await sessionFromRequest(request);
  if (session) return null;
  send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid SIWE session is required.' } });
  return true;
}

async function rejectUnlessRole(request, response, allowedRoles = ['admin']) {
  const session = await sessionFromRequest(request);
  if (!session) {
    send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid SIWE session is required.' } });
    return true;
  }
  const role = getSessionRole(session.address);
  if (!allowedRoles.includes(role)) {
    send(response, 403, {
      error: {
        code: 'FORBIDDEN',
        message: `Action requires one of the following roles: [${allowedRoles.join(', ')}]. Current role: '${role}'.`,
      },
    });
    return true;
  }
  return false;
}

function readJson(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0; let done = false;
    request.on('data', (chunk) => { if (done) return; size += chunk.length; if (size > maxBytes) { done = true; reject(Object.assign(new Error('Request body exceeds limit.'), { status: 413 })); request.destroy(); } else body += chunk; });
    request.on('end', () => { if (done) return; try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); } });
    request.on('error', reject);
  });
}

function parseTimeRemaining(endTime) {
  const diff = new Date(endTime).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((diff % (1000 * 60)) / 1000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${mins}m ${secs}s`;
}

const sseClients = new Set();

export function broadcastSse(eventType, data) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(message);
    } catch {
      sseClients.delete(res);
    }
  }
}

let lastLotUpdate = 0;
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const latest = await prisma.lot.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    if (latest && latest.updatedAt.getTime() > lastLotUpdate) {
      lastLotUpdate = latest.updatedAt.getTime();
      broadcastSse('lots_updated', { time: lastLotUpdate });
    }
  } catch {}
}, 1500);

function formatLotResponse(lot) {
  const highestBidEth = formatEther(BigInt(lot.highestBidWei || '0'));
  const reserveEth = formatEther(BigInt(lot.reserveWei || '0'));
  const buyNowWei = lot.buyNowWei || '0';
  const buyNowEth = buyNowWei !== '0' ? formatEther(BigInt(buyNowWei)) : null;
  return {
    id: lot.id,
    lotId: lot.lotId,
    chainId: lot.chainId,
    auctionAddress: lot.auctionAddress,
    nftAddress: lot.nftAddress,
    tokenId: lot.tokenId,
    creator: lot.creator,
    title: lot.title || null,
    imageUrl: lot.imageUrl || '',
    artistName: lot.artistName || null,
    artistHandle: lot.artistHandle || null,
    reserveEth,
    buyNowEth,
    buyNowWei,
    minIncrementEth: formatEther(BigInt(lot.minIncrementWei || '0')),
    highestBidEth,
    highestBidder: lot.highestBidder,
    startTime: lot.startTime,
    endTime: lot.endTime,
    endsIn: parseTimeRemaining(lot.endTime),
    status: lot.status,
    bidCount: lot.bids ? lot.bids.length : 0,
    bids: lot.bids ? lot.bids.map((b) => ({
      id: b.id,
      bidder: b.bidder,
      amountEth: formatEther(BigInt(b.amountWei)),
      transactionHash: b.transactionHash,
      timestamp: b.timestamp,
    })) : [],
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (!rateLimit(request, response)) return;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return send(response, 200, { ok: true });
  }

  // SSE Live Event Stream
  if (request.method === 'GET' && (url.pathname === '/api/stream' || url.pathname === '/stream')) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ active: true })}\n\n`);
    sseClients.add(response);
    request.on('close', () => {
      sseClients.delete(response);
    });
    return;
  }

  // Static files in /uploads/
  if (url.pathname.startsWith('/uploads/')) {
    const filename = path.basename(url.pathname);
    const uploadsDir = path.resolve('uploads');
    const filePath = path.resolve(uploadsDir, filename);

    if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      const ext = path.extname(filename).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.json') contentType = 'application/json';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.webp') contentType = 'image/webp';
      else if (ext === '.svg') contentType = 'image/svg+xml';
      else if (ext === '.gif') contentType = 'image/gif';

      const fileBuffer = fs.readFileSync(filePath);
      return send(response, 200, fileBuffer, contentType);
    }
    return send(response, 404, { message: 'File not found.' });
  }

  // Health
  if (url.pathname === '/health') {
    return send(response, 200, { status: 'ok', service: 'patronage-api', provider: 'local', timestamp: new Date().toISOString() });
  }

  if (url.pathname === '/api/health/indexer') {
    try {
      const state = await prisma.indexerState.findFirst({ orderBy: { updatedAt: 'desc' } });
      const currentBlock = await rpcClient.getBlockNumber();
      const indexedBlock = state ? BigInt(state.lastProcessedBlock) : 0n;
      const lag = currentBlock > indexedBlock ? currentBlock - indexedBlock : 0n;
      const healthy = Boolean(state && state.status === 'healthy' && lag <= 5n);
      return send(response, healthy ? 200 : 503, {
        status: state ? state.status : 'waiting',
        healthy,
        currentBlock: currentBlock.toString(),
        indexedBlock: indexedBlock.toString(),
        lag: lag.toString(),
        lastSyncAt: state?.lastSyncAt || null,
        retryCount: state?.retryCount || 0,
        deadLetterCount: state?.deadLetterCount || 0,
        lastError: state?.lastError || null,
        startedAt: state?.startedAt || null,
      });
    } catch (err) {
      return send(response, 503, { status: 'unavailable', message: 'Indexer state is unavailable.' });
    }
  }

  // GET SIWE Nonce
  if (request.method === 'GET' && (url.pathname === '/api/siwe/nonce' || url.pathname === '/siwe/nonce')) {
    const nonce = await generateNonce();
    return send(response, 200, { nonce });
  }

  // POST SIWE Signature Verification
  if (request.method === 'POST' && (url.pathname === '/api/siwe/verify' || url.pathname === '/siwe/verify')) {
    try {
        const { address, message, signature, nonce } = await readJson(request);
        if (!address || !message || !signature) {
          return send(response, 400, { error: { code: 'INVALID_INPUT', message: 'Missing address, message, or signature.' } });
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          return send(response, 400, { error: { code: 'INVALID_ADDRESS', message: 'Invalid Ethereum address format.' } });
        }
        const isNonceValid = await consumeNonce(nonce);
        if (!nonce || !isNonceValid || !message.includes(`Nonce: ${nonce}`)) {
          return send(response, 400, { error: { code: 'INVALID_NONCE', message: 'Invalid or expired SIWE nonce.' } });
        }
        const validation = validateSiweMessage(message, {
          expectedAddress: address,
          expectedNonce: nonce,
          expectedChainId: activeChainId,
        });
        if (!validation.valid) {
          return send(response, 400, { error: { code: 'INVALID_SIWE_MESSAGE', message: validation.reason } });
        }
        const isValid = await verifySiweSignature({ address, message, signature, publicClient: rpcClient });
        if (!isValid) {
          return send(response, 401, { error: { code: 'INVALID_SIGNATURE', message: 'Invalid SIWE wallet signature.' } });
        }
        if (isAddressSanctioned(address)) {
          return send(response, 403, { error: { code: 'SANCTIONED_ADDRESS', message: 'Address is blocked by OFAC sanctions compliance.' } });
        }
        const session = await createSession(address);
        const role = getSessionRole(address);
        return send(response, 200, { verified: true, address, session, role });
    } catch (err) {
      return send(response, err.status || 500, { error: { code: err.status === 400 ? 'BAD_REQUEST' : 'SIWE_ERROR', message: err.status ? err.message : 'SIWE verification error.' } });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/siwe/logout') {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await revokeSession(token);
    return send(response, 200, { loggedOut: true });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ADMIN: Artist Curation
  // ────────────────────────────────────────────────────────────────────────────

  // GET /api/admin/artists — list all artist applications (admin only)
  if (request.method === 'GET' && url.pathname === '/api/admin/artists') {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    try {
      const status = url.searchParams.get('status') || undefined;
      const artists = await prisma.artist.findMany({
        where: status ? { approvalStatus: status } : undefined,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { lots: true } } },
      });
      return send(response, 200, { data: artists });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // POST /api/admin/artists/:address/approve — approve a curated artist
  if (request.method === 'POST' && /^\/api\/admin\/artists\/0x[0-9a-fA-F]+\/approve$/.test(url.pathname)) {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    const address = url.pathname.split('/')[4].toLowerCase();
    try {
      const artist = await prisma.artist.updateMany({
        where: { walletAddress: address },
        data: { approvalStatus: 'approved' },
      });
      if (artist.count === 0) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Artist not found.' } });
      return send(response, 200, { data: { address, approvalStatus: 'approved' } });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // POST /api/admin/artists/:address/reject — reject / suspend an artist
  if (request.method === 'POST' && /^\/api\/admin\/artists\/0x[0-9a-fA-F]+\/reject$/.test(url.pathname)) {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    const address = url.pathname.split('/')[4].toLowerCase();
    try {
      const artist = await prisma.artist.updateMany({
        where: { walletAddress: address },
        data: { approvalStatus: 'rejected' },
      });
      if (artist.count === 0) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Artist not found.' } });
      return send(response, 200, { data: { address, approvalStatus: 'rejected' } });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ADMIN: Sanctions Feed & Compliance Operations
  // ────────────────────────────────────────────────────────────────────────────

  // GET /api/admin/sanctions/status — check sanctions feed status, cadence, and metadata (admin only)
  if (request.method === 'GET' && url.pathname === '/api/admin/sanctions/status') {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    const meta = getSanctionsMetadata();
    return send(response, 200, {
      data: {
        ...meta,
        schedulerActive: Boolean(sanctionsSyncTimer),
        syncIntervalMs: SANCTIONS_SYNC_INTERVAL_MS,
        syncCadenceHours: SANCTIONS_SYNC_INTERVAL_MS / (1000 * 60 * 60),
      },
    });
  }

  // POST /api/admin/sanctions/sync — trigger immediate manual sanctions re-sync (admin only)
  if (request.method === 'POST' && url.pathname === '/api/admin/sanctions/sync') {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    try {
      const syncResult = await syncSanctionsFeed();
      return send(response, 200, {
        success: true,
        message: 'Sanctions feed synchronized successfully.',
        data: syncResult,
      });
    } catch (err) {
      return send(response, 500, { error: { code: 'SYNC_ERROR', message: err.message } });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ADMIN: Session & Nonce Lifecycle Maintenance
  // ────────────────────────────────────────────────────────────────────────────

  // POST /api/admin/sessions/prune — trigger on-demand cleanup of expired sessions and nonces (admin only)
  if (request.method === 'POST' && url.pathname === '/api/admin/sessions/prune') {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    try {
      const result = await pruneExpiredSessionsAndNonces();
      return send(response, 200, {
        success: true,
        message: 'Expired sessions and nonces pruned successfully.',
        data: result,
      });
    } catch (err) {
      return send(response, 500, { error: { code: 'PRUNE_ERROR', message: err.message } });
    }
  }

  // GET /api/admin/sessions/status — inspect session storage metrics and prune cadence (admin only)
  if (request.method === 'GET' && url.pathname === '/api/admin/sessions/status') {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    try {
      const [sessions, nonces] = await Promise.all([
        prisma.$queryRaw`SELECT count(*) as count FROM "Session"`.catch(() => [{ count: 0 }]),
        prisma.$queryRaw`SELECT count(*) as count FROM "SiweNonce"`.catch(() => [{ count: 0 }]),
      ]);
      return send(response, 200, {
        data: {
          totalSessions: Number(sessions[0]?.count || 0),
          totalNonces: Number(nonces[0]?.count || 0),
          schedulerActive: Boolean(sessionPruneTimer),
          pruneIntervalMs: SESSION_PRUNE_INTERVAL_MS,
          pruneCadenceHours: SESSION_PRUNE_INTERVAL_MS / (1000 * 60 * 60),
        },
      });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // POST /api/artists/apply — public artist application (SIWE-gated)
  if (request.method === 'POST' && url.pathname === '/api/artists/apply') {
    if (await rejectUnauthorized(request, response)) return;
    const sess = await sessionFromRequest(request);
    try {
      const { handle, displayName, bio } = await readJson(request);
      if (!handle || !displayName) return send(response, 400, { error: { code: 'BAD_REQUEST', message: 'handle and displayName are required.' } });
      if (!/^[a-z0-9_]{2,32}$/.test(handle)) return send(response, 400, { error: { code: 'BAD_REQUEST', message: 'handle must be 2–32 lowercase alphanumeric/underscore chars.' } });
      const artist = await prisma.artist.upsert({
        where: { walletAddress: sess.address },
        create: { walletAddress: sess.address, handle: handle.toLowerCase(), displayName, bio: bio || null, approvalStatus: 'pending' },
        update: { displayName, bio: bio || null },
      });
      return send(response, 201, { data: artist });
    } catch (err) {
      if (err.code === 'P2002') return send(response, 409, { error: { code: 'CONFLICT', message: 'Handle or wallet address already registered.' } });
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // GET /api/profile/:address — full collector/artist profile + their lots
  if (request.method === 'GET' && /^\/api\/profile\/0x[0-9a-fA-F]+$/.test(url.pathname)) {
    const address = url.pathname.split('/')[3].toLowerCase();
    try {
      const [artist, lots, bidsPlaced, notifications] = await Promise.all([
        prisma.artist.findUnique({ where: { walletAddress: address } }),
        prisma.lot.findMany({
          where: { creator: { equals: address, mode: 'insensitive' } },
          include: { bids: { orderBy: { timestamp: 'desc' }, take: 1 } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.bid.findMany({
          where: { bidder: { equals: address, mode: 'insensitive' } },
          orderBy: { timestamp: 'desc' },
          take: 20,
          include: { lot: { select: { title: true, imageUrl: true, status: true, lotId: true } } },
        }),
        prisma.notification.findMany({
          where: { wallet: { equals: address, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);
      return send(response, 200, {
        data: {
          address,
          artist: artist || null,
          lotsCreated: lots.map(formatLotResponse),
          bidsPlaced: bidsPlaced.map((b) => ({
            lotId: b.lot?.lotId,
            title: b.lot?.title,
            imageUrl: b.lot?.imageUrl,
            status: b.lot?.status,
            amountEth: formatEther(BigInt(b.amountWei)),
            timestamp: b.timestamp,
          })),
          recentNotifications: notifications.map((n) => ({
            id: n.id,
            type: n.type,
            payload: JSON.parse(n.payload || '{}'),
            createdAt: n.createdAt,
          })),
        },
      });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // GET /api/notifications — authenticated user's notification feed
  if (request.method === 'GET' && url.pathname === '/api/notifications') {
    if (await rejectUnauthorized(request, response)) return;
    const sess = await sessionFromRequest(request);
    try {
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10));
      const notifications = await prisma.notification.findMany({
        where: { wallet: { equals: sess.address, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      });
      const total = await prisma.notification.count({
        where: { wallet: { equals: sess.address, mode: 'insensitive' } },
      });
      return send(response, 200, {
        data: notifications.map((n) => ({ id: n.id, type: n.type, payload: JSON.parse(n.payload || '{}'), createdAt: n.createdAt })),
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // GET /api/moderation/delisted (Admin / Moderator only)
  if (request.method === 'GET' && url.pathname === '/api/moderation/delisted') {
    if (await rejectUnlessRole(request, response, ['admin', 'moderator'])) return;
    try {
      const records = await prisma.$queryRaw`SELECT * FROM "DelistedToken" ORDER BY "delistedAt" DESC;`.catch(() => []);
      return send(response, 200, { data: records });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // POST /api/moderation/delist (Admin / Moderator only - DMCA takedown flow)
  if (request.method === 'POST' && url.pathname === '/api/moderation/delist') {
    if (await rejectUnlessRole(request, response, ['admin', 'moderator'])) return;
    try {
      const { contractAddress, tokenId, reason } = await readJson(request);
      if (!contractAddress || tokenId === undefined) {
        return send(response, 400, { error: { code: 'INVALID_INPUT', message: 'contractAddress and tokenId are required.' } });
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
        return send(response, 400, { error: { code: 'INVALID_ADDRESS', message: 'contractAddress must be a valid 42-character Ethereum address.' } });
      }
      const id = `${contractAddress.toLowerCase()}-${tokenId}`;
      const lowerAddress = contractAddress.toLowerCase();
      const tokenIdStr = tokenId.toString();
      const delistReason = reason || 'DMCA or Policy Violation';
      await prisma.$executeRaw`
        INSERT INTO "DelistedToken" ("id", "contractAddress", "tokenId", "reason", "delistedAt")
        VALUES (${id}, ${lowerAddress}, ${tokenIdStr}, ${delistReason}, CURRENT_TIMESTAMP)
        ON CONFLICT("contractAddress", "tokenId") DO UPDATE SET "reason" = excluded."reason", "delistedAt" = CURRENT_TIMESTAMP;
      `;
      broadcastSse('lots_updated', { type: 'delist', contractAddress, tokenId });
      return send(response, 200, { success: true, delisted: { contractAddress: contractAddress.toLowerCase(), tokenId: tokenId.toString(), reason } });
    } catch (err) {
      return send(response, 500, { error: { code: 'DB_ERROR', message: err.message } });
    }
  }

  // GET /api/users/:address/history.csv (Transaction history export for tax self-reporting)
  if (request.method === 'GET' && url.pathname.match(/^\/api\/users\/0x[a-fA-F0-9]{40}\/history\.csv$/)) {
    const address = url.pathname.split('/')[3].toLowerCase();
    try {
      const bids = await prisma.bid.findMany({
        where: { bidder: { equals: address } },
        include: { lot: true },
        orderBy: { timestamp: 'desc' },
      });
      const lotsCreated = await prisma.lot.findMany({
        where: { creator: { equals: address } },
        orderBy: { createdAt: 'desc' },
      });

      let csv = 'Timestamp,Type,LotId,NFTContract,TokenId,AmountETH,TxHash\n';
      for (const b of bids) {
        const amt = b.amountWei ? formatEther(BigInt(b.amountWei)) : '0';
        csv += `"${b.timestamp.toISOString()}","BID","${b.lot?.lotId || b.lotId}","${b.lot?.nftAddress || ''}","${b.lot?.tokenId || ''}","${amt}","${b.transactionHash}"\n`;
      }
      for (const l of lotsCreated) {
        const amt = l.reserveWei ? formatEther(BigInt(l.reserveWei)) : '0';
        csv += `"${l.createdAt.toISOString()}","CREATE_LOT","${l.lotId}","${l.nftAddress}","${l.tokenId}","${amt}",""\n`;
      }

      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="patronage-history-${address.substring(0, 8)}.csv"`,
      });
      return response.end(csv);
    } catch (err) {
      return send(response, 500, { error: { code: 'CSV_ERROR', message: err.message } });
    }
  }

  if (url.pathname.startsWith('/api/admin') || url.pathname.startsWith('/api/moderation') || url.pathname.startsWith('/api/settlement')) {
    if (await rejectUnlessRole(request, response, ['admin'])) return;
    return send(response, 501, { error: { code: 'NOT_IMPLEMENTED', message: 'This capability is not implemented yet.' } });
  }

  // Deployment Manifest (Contracts & ABIs)
  if (url.pathname === '/api/deployment' || url.pathname === '/deployment') {
    const requestedChainId = url.searchParams.get('chainId') || process.env.CHAIN_ID || '31337';
    let manifestPath = path.resolve('contracts', 'deployments', `${requestedChainId}.json`);
    if (!fs.existsSync(manifestPath)) {
      manifestPath = path.resolve('contracts', 'deployments', '31337.json');
    }
    if (!fs.existsSync(manifestPath)) {
      const allManifests = fs.existsSync(path.resolve('contracts', 'deployments'))
        ? fs.readdirSync(path.resolve('contracts', 'deployments')).filter((f) => f.endsWith('.json'))
        : [];
      if (allManifests.length > 0) {
        manifestPath = path.resolve('contracts', 'deployments', allManifests[0]);
      }
    }
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return send(response, 200, { data: manifest });
    }
    return send(response, 404, { message: 'Deployment manifest not found. Run contract deployment first.' });
  }

  // GET Offers
  if (request.method === 'GET' && url.pathname === '/api/offers') {
    try {
      const chainIdParam = Number(url.searchParams.get('chainId') || activeChainId);
      const nftAddress = url.searchParams.get('nftAddress')?.toLowerCase();
      const tokenId = url.searchParams.get('tokenId');
      const buyer = url.searchParams.get('buyer')?.toLowerCase();

      const where = { chainId: chainIdParam };
      if (nftAddress) where.nftAddress = nftAddress;
      if (tokenId) where.tokenId = tokenId;
      if (buyer) where.buyer = buyer;

      const offers = await prisma.offer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      return send(response, 200, {
        data: offers.map((o) => ({
          id: o.id,
          chainId: o.chainId,
          nftAddress: o.nftAddress,
          tokenId: o.tokenId,
          buyer: o.buyer,
          amountWei: o.amountWei,
          amountEth: formatEther(BigInt(o.amountWei)),
          counterAmountWei: o.counterAmountWei,
          counterAmountEth: o.counterAmountWei && o.counterAmountWei !== '0' ? formatEther(BigInt(o.counterAmountWei)) : null,
          status: o.status,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
      });
    } catch (err) {
      console.error('[api] Error fetching offers:', err);
      return send(response, 500, { message: 'Failed to retrieve offers.' });
    }
  }

  // GET Lazy Mint Vouchers
  if (request.method === 'GET' && url.pathname === '/api/vouchers') {
    try {
      const chainIdParam = Number(url.searchParams.get('chainId') || activeChainId);
      const nftAddress = url.searchParams.get('nftAddress')?.toLowerCase();
      const tokenId = url.searchParams.get('tokenId');
      const artist = url.searchParams.get('artist')?.toLowerCase();
      const status = url.searchParams.get('status') || 'active';

      const where = { chainId: chainIdParam };
      if (status !== 'all') where.status = status;
      if (nftAddress) where.nftAddress = nftAddress;
      if (tokenId) where.tokenId = tokenId;
      if (artist) where.artist = artist;

      const vouchers = await prisma.lazyVoucher.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      return send(response, 200, {
        data: vouchers.map((v) => ({
          id: v.id,
          chainId: v.chainId,
          nftAddress: v.nftAddress,
          tokenId: v.tokenId,
          minPriceWei: v.minPriceWei,
          minPriceEth: formatEther(BigInt(v.minPriceWei)),
          metadataUri: v.metadataUri,
          artist: v.artist,
          nonce: v.nonce,
          signature: v.signature,
          title: v.title,
          imageUrl: v.imageUrl,
          artistName: v.artistName,
          status: v.status,
          redeemedBy: v.redeemedBy,
          redeemedTx: v.redeemedTx,
          createdAt: v.createdAt,
        })),
      });
    } catch (err) {
      console.error('[api] Error fetching vouchers:', err);
      return send(response, 500, { message: 'Failed to retrieve lazy mint vouchers.' });
    }
  }

  // POST Lazy Mint Voucher
  if (request.method === 'POST' && url.pathname === '/api/vouchers') {
    try {
      const payload = await readJson(request);
      const {
        chainId: voucherChainId = activeChainId,
        nftAddress,
        tokenId,
        minPriceWei,
        metadataUri,
        artist,
        nonce,
        signature,
        title,
        imageUrl,
        artistName,
      } = payload;

      if (!nftAddress || !artist || !signature || !minPriceWei) {
        return send(response, 400, { error: { code: 'BAD_REQUEST', message: 'Missing required voucher parameters.' } });
      }

      const voucher = await prisma.lazyVoucher.upsert({
        where: {
          chainId_nftAddress_tokenId_nonce: {
            chainId: Number(voucherChainId),
            nftAddress: nftAddress.toLowerCase(),
            tokenId: (tokenId || '0').toString(),
            nonce: nonce.toString(),
          },
        },
        create: {
          chainId: Number(voucherChainId),
          nftAddress: nftAddress.toLowerCase(),
          tokenId: (tokenId || '0').toString(),
          minPriceWei: minPriceWei.toString(),
          metadataUri: metadataUri || '',
          artist: artist.toLowerCase(),
          nonce: nonce.toString(),
          signature,
          title: title || null,
          imageUrl: imageUrl || null,
          artistName: artistName || null,
          status: 'active',
        },
        update: {
          minPriceWei: minPriceWei.toString(),
          metadataUri: metadataUri || '',
          signature,
          title: title || null,
          imageUrl: imageUrl || null,
          artistName: artistName || null,
          status: 'active',
        },
      });

      return send(response, 201, { data: voucher });
    } catch (err) {
      console.error('[api] Save voucher error:', err);
      return send(response, 500, { message: 'Failed to record lazy mint voucher.' });
    }
  }

  // GET Lots — paginated, filterable, searchable
  if (request.method === 'GET' && (url.pathname === '/api/lots' || url.pathname === '/lots')) {
    try {
      const page    = Math.max(1, parseInt(url.searchParams.get('page')   || '1',    10));
      const limit   = Math.min(100, parseInt(url.searchParams.get('limit')  || '50',   10));
      const q       = url.searchParams.get('q')       || '';
      const status  = url.searchParams.get('status')  || '';
      const sortParam = url.searchParams.get('sort')  || 'newest';
      const creator = url.searchParams.get('creator') || '';

      const where = {};
      if (status && ['active','settled','cancelled','indexed'].includes(status)) where.status = status;
      if (creator) where.creator = { equals: creator, mode: 'insensitive' };
      if (q) {
        where.OR = [
          { title:        { contains: q, mode: 'insensitive' } },
          { artistName:   { contains: q, mode: 'insensitive' } },
          { artistHandle: { contains: q, mode: 'insensitive' } },
          { creator:      { contains: q, mode: 'insensitive' } },
        ];
      }

      const orderBy =
        sortParam === 'highest_bid' ? { highestBidWei: 'desc' } :
        sortParam === 'ending_soon' ? { endTime: 'asc' } :
        sortParam === 'reserve'     ? { reserveWei: 'desc' } :
        { createdAt: 'desc' };

      const [lots, total] = await prisma.$transaction([
        prisma.lot.findMany({
          where,
          include: { bids: { orderBy: { timestamp: 'desc' } } },
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.lot.count({ where }),
      ]);

      const delisted = await prisma.$queryRaw`SELECT "contractAddress", "tokenId" FROM "DelistedToken";`.catch(() => []);
      const delistedSet = new Set((delisted || []).map((d) => `${d.contractAddress.toLowerCase()}-${d.tokenId}`));
      const activeLots = lots.filter((l) => !delistedSet.has(`${l.nftAddress.toLowerCase()}-${l.tokenId}`));

      return send(response, 200, {
        data: activeLots.map(formatLotResponse),
        meta: { page, limit, total: activeLots.length, pages: Math.ceil(activeLots.length / limit) },
      });
    } catch (err) {
      console.error('[api] Error fetching lots:', err);
      return send(response, 500, { message: 'Error fetching lots from local database.' });
    }
  }

  // GET Single Lot
  if (request.method === 'GET' && url.pathname.startsWith('/api/lots/')) {
    const lotId = url.pathname.replace('/api/lots/', '');
    try {
      const lot = await prisma.lot.findFirst({
        where: { OR: [{ id: lotId }, { lotId: lotId }] },
        include: { bids: { orderBy: { timestamp: 'desc' } } },
      });
      if (!lot) return send(response, 404, { message: 'Lot not found.' });
      return send(response, 200, { data: formatLotResponse(lot) });
    } catch (err) {
      return send(response, 500, { message: 'Error fetching lot.' });
    }
  }

  // POST Upload (Create Artwork Metadata & Storage)
  if (request.method === 'POST' && url.pathname === '/api/upload') {
    if (await rejectUnauthorized(request, response)) return;
    let body = '';
    let bodySize = 0;
    const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB limit

    let isOverLimit = false;
    request.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_UPLOAD_SIZE) {
        isOverLimit = true;
        request.destroy();
      } else {
        body += chunk;
      }
    });

    request.on('end', async () => {
      if (isOverLimit) {
        return send(response, 413, { message: 'Payload size exceeds 10MB limit.' });
      }
      try {
        const payload = JSON.parse(body || '{}');
        const { title, description, imageBase64, filename, artistName, artistHandle } = payload;

        if (!title || (!imageBase64 && !payload.imageUrl)) {
          return send(response, 400, { message: 'Title and artwork image are required.' });
        }

        let imageUrl = payload.imageUrl;
        let imageUri = payload.imageUrl;

        if (imageBase64) {
          const mimeMatch = imageBase64.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,/i);
          const mimeType = mimeMatch ? mimeMatch[1] : null;

          if (!mimeType) {
            return send(response, 400, { message: 'Invalid image format or MIME type. Only PNG, JPEG, WEBP, GIF, and SVG are supported.' });
          }

          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/i, '');
          const buffer = Buffer.from(base64Data, 'base64');
          const safeFilename = path.basename(filename || 'artwork.png');

          const uploadResult = await storage.put(buffer, safeFilename, mimeType);
          imageUrl = uploadResult.publicUrl;
          imageUri = uploadResult.uri;
        }

        const metaResult = await storage.createMetadata({
          title,
          description: description || '',
          imageUri,
          imageUrl,
          artistName: artistName || null,
          artistHandle: artistHandle || null,
        });

        return send(response, 201, {
          data: {
            metadataUri: metaResult.uri,
            imageUrl,
            cid: metaResult.cid,
          },
        });
      } catch (err) {
        console.error('[api] Upload error:', err);
        return send(response, 500, { message: 'Failed to process local file upload.' });
      }
    });
    return;
  }

  return send(response, 404, { message: 'Route not found.' });
});

function startBackgroundSchedulers() {
  // 1. Sanctions feed periodic sync
  if (process.env.DISABLE_SANCTIONS_SCHEDULER !== 'true') {
    syncSanctionsFeed().catch((err) => {
      console.warn(`[sanctions] Initial startup sync notice: ${err.message}`);
    });
    sanctionsSyncTimer = setInterval(() => {
      console.log(`[sanctions] Running scheduled periodic OFAC sanctions sync...`);
      syncSanctionsFeed().catch((err) => {
        console.error(`[sanctions] Scheduled sync error: ${err.message}`);
      });
    }, SANCTIONS_SYNC_INTERVAL_MS);
    if (sanctionsSyncTimer.unref) sanctionsSyncTimer.unref();
  }

  // 2. Session and nonce periodic maintenance pruner
  if (process.env.DISABLE_SESSION_PRUNER !== 'true') {
    pruneExpiredSessionsAndNonces().then((res) => {
      if (res.prunedSessions > 0 || res.prunedNonces > 0) {
        console.log(`[siwe] Boot maintenance: pruned ${res.prunedSessions} expired sessions, ${res.prunedNonces} expired nonces.`);
      }
    }).catch(() => {});
    sessionPruneTimer = setInterval(() => {
      pruneExpiredSessionsAndNonces().then((res) => {
        if (res.prunedSessions > 0 || res.prunedNonces > 0) {
          console.log(`[siwe] Scheduled maintenance: pruned ${res.prunedSessions} expired sessions, ${res.prunedNonces} expired nonces.`);
        }
      }).catch((err) => {
        console.error(`[siwe] Scheduled session prune error: ${err.message}`);
      });
    }, SESSION_PRUNE_INTERVAL_MS);
    if (sessionPruneTimer.unref) sessionPruneTimer.unref();
  }
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[api] Patronage Local API listening on http://127.0.0.1:${port}`);
  startBackgroundSchedulers();
});

const gracefulShutdown = () => {
  if (sanctionsSyncTimer) clearInterval(sanctionsSyncTimer);
  if (sessionPruneTimer) clearInterval(sessionPruneTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
