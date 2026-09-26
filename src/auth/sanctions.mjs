/**
 * OFAC & Sanctions List Checker
 * Validates wallet addresses against Office of Foreign Assets Control (OFAC)
 * Specially Designated Nationals (SDN) and blocked cryptocurrency addresses.
 * 
 * Supports dynamic feed ingestion (e.g. daily OFAC SDN sync or Chainalysis/TRM feeds)
 * with in-memory caching and sync metadata.
 */

import fs from 'node:fs';
import path from 'node:path';

// Baseline seed addresses (well-known primary SDN entries)
const INITIAL_SEEDS = [
  '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c', // Lazarus Group / Ronin Exploiter
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', // Tornado Cash 1
  '0x722122df12d450ac402db98d5b12778713782d10', // Tornado Cash 2
  '0xd4b488a757f2c58f314ec3d6114f29e350529d21', // Tornado Cash 3
  '0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a', // Tornado Cash 4
  '0x7ffaa5794704b6d60412660b9960dd563b089880', // Blender.io
];

let sanctionedAddresses = new Set(INITIAL_SEEDS.map((a) => a.toLowerCase()));

let feedMetadata = {
  source: 'static-seed',
  lastSyncAt: null,
  totalCount: sanctionedAddresses.size,
  isLiveFeedConnected: false,
};

// Auto-load cached SDN list from disk if present
try {
  const cachePath = path.resolve('src', 'auth', 'ofac-sanctions-cache.json');
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Array.isArray(cached.addresses) && cached.addresses.length > 0) {
      cached.addresses.forEach((a) => sanctionedAddresses.add(a.toLowerCase()));
      feedMetadata = {
        source: cached.source || 'ofac-sanctions-cache',
        lastSyncAt: cached.updatedAt,
        totalCount: sanctionedAddresses.size,
        isLiveFeedConnected: true,
      };
    }
  }
} catch {}

export function isAddressSanctioned(address) {
  if (!address || typeof address !== 'string' || address.length !== 42) return false;
  return sanctionedAddresses.has(address.toLowerCase());
}

/**
 * Ingest an array of sanctioned Ethereum addresses from a live external source
 * (e.g., US Treasury OFAC SDN parser, Chainalysis API, or TRM free feed).
 */
export function updateSanctionsList(addresses, sourceName = 'live-feed') {
  if (!Array.isArray(addresses)) {
    throw new Error('updateSanctionsList expects an array of hex addresses');
  }
  const nextSet = new Set(INITIAL_SEEDS.map((a) => a.toLowerCase()));
  for (const addr of addresses) {
    if (typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42) {
      nextSet.add(addr.toLowerCase());
    }
  }
  sanctionedAddresses = nextSet;
  feedMetadata = {
    source: sourceName,
    sourceType: sourceName.includes('ultrasoundmoney') ? 'community-mirror' : (sourceName === 'static-seed' ? 'static-seed' : 'external-provider'),
    regulatoryStatus: 'AUTOMATED_PRE_SCREENING_ONLY',
    legalNote: 'Automated pre-screening against community-maintained mirror (ultrasoundmoney). Formal regulatory determination under US OFAC / FIU-IND mandates requires legal counsel review.',
    lastSyncAt: new Date().toISOString(),
    totalCount: sanctionedAddresses.size,
    isLiveFeedConnected: sourceName !== 'static-seed',
  };
  return feedMetadata;
}

export function getSanctionsMetadata() {
  return { ...feedMetadata, currentSize: sanctionedAddresses.size };
}

