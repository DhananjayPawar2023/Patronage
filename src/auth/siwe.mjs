import { verifyMessage } from 'viem';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

let prisma;
try {
  prisma = new PrismaClient();
} catch (e) {
  console.warn('[siwe] PrismaClient initialization deferred:', e.message);
}

// In-memory cache + persistent backing for zero-downtime restarts
const nonceCache = new Map();
const sessionCache = new Map();
const SESSION_TTL_MS = Number(process.env.SIWE_SESSION_TTL_MS || 24 * 60 * 60 * 1000); // 24 hours
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a cryptographically secure random nonce for EIP-4361 SIWE
 * Persisted to database for cross-worker / post-restart validity.
 */
export async function generateNonce() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  nonceCache.set(nonce, expiresAt.getTime());

  if (prisma) {
    try {
      const id = `nonce-${nonce}`;
      const expiresAtIso = expiresAt.toISOString();
      await prisma.$executeRaw`
        INSERT INTO "SiweNonce" ("id", "nonce", "expiresAt", "createdAt")
        VALUES (${id}, ${nonce}, ${expiresAtIso}, CURRENT_TIMESTAMP);
      `;
    } catch (err) {
      // Non-fatal if DB is offline, memory cache holds
    }
  }
  return nonce;
}

/**
 * Validate and consume a generated nonce (strictly single-use, prevents replay attacks)
 */
export async function consumeNonce(nonce) {
  if (!nonce || typeof nonce !== 'string') return false;

  // 1. Check in-memory cache
  if (nonceCache.has(nonce)) {
    const expiry = nonceCache.get(nonce);
    nonceCache.delete(nonce);
    if (Date.now() > expiry) return false;

    if (prisma) {
      prisma.$executeRaw`DELETE FROM "SiweNonce" WHERE "nonce" = ${nonce};`.catch(() => {});
    }
    return true;
  }

  // 2. Fallback to database
  if (prisma) {
    try {
      const records = await prisma.$queryRaw`
        SELECT "expiresAt" FROM "SiweNonce" WHERE "nonce" = ${nonce} LIMIT 1;
      `;
      if (records && records.length > 0) {
        const row = records[0];
        await prisma.$executeRaw`DELETE FROM "SiweNonce" WHERE "nonce" = ${nonce};`;
        const expiryTime = new Date(row.expiresAt).getTime();
        return Date.now() <= expiryTime;
      }
    } catch (err) {
      return false;
    }
  }

  return false;
}

/**
 * Create a durable session
 */
export async function createSession(address) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const normalizedAddr = address.toLowerCase();

  sessionCache.set(token, { address: normalizedAddr, expiresAt: expiresAt.getTime() });

  if (prisma) {
    try {
      const id = `sess-${token}`;
      const expiresAtIso = expiresAt.toISOString();
      await prisma.$executeRaw`
        INSERT INTO "Session" ("id", "token", "address", "expiresAt", "createdAt")
        VALUES (${id}, ${token}, ${normalizedAddr}, ${expiresAtIso}, CURRENT_TIMESTAMP);
      `;
    } catch (err) {
      // memory cache preserves session
    }
  }

  return { token, address: normalizedAddr, expiresAt: expiresAt.toISOString() };
}

/**
 * Retrieve session by bearer token (durable across restarts)
 */
export async function getSession(token) {
  if (!token || typeof token !== 'string') return null;

  // 1. Check memory cache
  const cached = sessionCache.get(token);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      sessionCache.delete(token);
      if (prisma) prisma.$executeRaw`DELETE FROM "Session" WHERE "token" = ${token};`.catch(() => {});
      return null;
    }
    return { token, address: cached.address, expiresAt: new Date(cached.expiresAt).toISOString() };
  }

  // 2. Check database
  if (prisma) {
    try {
      const records = await prisma.$queryRaw`
        SELECT "address", "expiresAt" FROM "Session" WHERE "token" = ${token} LIMIT 1;
      `;
      if (records && records.length > 0) {
        const row = records[0];
        const expiryTime = new Date(row.expiresAt).getTime();
        if (Date.now() > expiryTime) {
          await prisma.$executeRaw`DELETE FROM "Session" WHERE "token" = ${token};`;
          return null;
        }
        // Repopulate memory cache
        sessionCache.set(token, { address: row.address, expiresAt: expiryTime });
        return { token, address: row.address, expiresAt: new Date(expiryTime).toISOString() };
      }
    } catch {}
  }

  return null;
}

/**
 * Revoke session globally
 */
export async function revokeSession(token) {
  if (!token) return false;
  sessionCache.delete(token);
  if (prisma) {
    try {
      await prisma.$executeRaw`DELETE FROM "Session" WHERE "token" = ${token};`;
    } catch {}
  }
  return true;
}

/**
 * Prune all expired sessions and single-use nonces from storage
 */
export async function pruneExpiredSessionsAndNonces() {
  const nowIso = new Date().toISOString();
  let prunedSessions = 0;
  let prunedNonces = 0;

  // Prune memory caches
  const nowMs = Date.now();
  for (const [token, sess] of sessionCache.entries()) {
    if (sess.expiresAt <= nowMs) sessionCache.delete(token);
  }
  for (const [nonce, expiry] of nonceCache.entries()) {
    if (expiry <= nowMs) nonceCache.delete(nonce);
  }

  // Prune database tables
  if (prisma) {
    try {
      prunedSessions = await prisma.$executeRaw`
        DELETE FROM "Session" WHERE "expiresAt" < ${nowIso};
      `;
      prunedNonces = await prisma.$executeRaw`
        DELETE FROM "SiweNonce" WHERE "expiresAt" < ${nowIso};
      `;
    } catch (err) {
      console.error('[siwe] Session pruning error:', err.message);
    }
  }

  return { prunedSessions, prunedNonces, timestamp: nowIso };
}

/**
 * Format a standard EIP-4361 SIWE message string
 */
export function createSiweMessage({ domain, address, statement, uri, version = '1', chainId = 31337, nonce, issuedAt }) {
  return `${domain} wants you to sign in with your Ethereum account:
${address}

${statement}

URI: ${uri}
Version: ${version}
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

/**
 * Validate EIP-4361 Message fields against server policy
 */
export function validateSiweMessage(message, { expectedAddress, expectedNonce, expectedChainId, allowedDomains = [] }) {
  if (!message || typeof message !== 'string') return { valid: false, reason: 'Empty message' };

  // Parse fields
  const addressMatch = message.match(/^([^\n]+) wants you to sign in with your Ethereum account:\n(0x[a-fA-F0-9]{40})/m);
  if (!addressMatch) return { valid: false, reason: 'Invalid header format' };

  const domain = addressMatch[1].trim();
  const address = addressMatch[2].toLowerCase();

  const uriMatch = message.match(/URI:\s*(\S+)/);
  const versionMatch = message.match(/Version:\s*(\S+)/);
  const chainIdMatch = message.match(/Chain ID:\s*(\d+)/);
  const nonceMatch = message.match(/Nonce:\s*(\S+)/);
  const issuedAtMatch = message.match(/Issued At:\s*(\S+)/);

  if (!uriMatch || !versionMatch || !chainIdMatch || !nonceMatch || !issuedAtMatch) {
    return { valid: false, reason: 'Missing mandatory EIP-4361 fields' };
  }

  if (expectedAddress && address !== expectedAddress.toLowerCase()) {
    return { valid: false, reason: 'Message address does not match requested signer' };
  }

  if (expectedNonce && nonceMatch[1] !== expectedNonce) {
    return { valid: false, reason: 'Message nonce does not match issued nonce' };
  }

  if (expectedChainId && Number(chainIdMatch[1]) !== Number(expectedChainId)) {
    return { valid: false, reason: `Chain ID mismatch (got ${chainIdMatch[1]}, expected ${expectedChainId})` };
  }

  if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
    return { valid: false, reason: `Unauthorized domain ${domain}` };
  }

  // Check issuedAt timestamp freshness (must not be in future > 1m or past > 10m)
  const issuedTime = new Date(issuedAtMatch[1]).getTime();
  if (isNaN(issuedTime)) return { valid: false, reason: 'Invalid Issued At timestamp' };
  const now = Date.now();
  if (issuedTime > now + 60_000) return { valid: false, reason: 'Issued At timestamp is in the future' };
  if (now - issuedTime > 10 * 60_000) return { valid: false, reason: 'SIWE message expired (issued > 10m ago)' };

  return { valid: true, domain, address, chainId: Number(chainIdMatch[1]), nonce: nonceMatch[1] };
}

/**
 * Cryptographically verify SIWE signature using Viem
 */
export async function verifySiweSignature({ address, message, signature, publicClient }) {
  try {
    const isValid = await verifyMessage({
      address,
      message,
      signature,
      ...(publicClient ? { publicClient } : {}),
    });
    return isValid;
  } catch (err) {
    console.error('[siwe] Signature verification error:', err.message);
    return false;
  }
}
