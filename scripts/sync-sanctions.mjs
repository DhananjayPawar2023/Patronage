import fs from 'node:fs';
import path from 'node:path';
import { updateSanctionsList, getSanctionsMetadata } from '../src/auth/sanctions.mjs';

const OFAC_CSV_FEED = process.env.OFAC_FEED_URL || 'https://raw.githubusercontent.com/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv';
const CACHE_FILE = path.resolve('src', 'auth', 'ofac-sanctions-cache.json');

export async function syncSanctionsFeed() {
  console.log('====================================================');
  console.log('      OFAC SDN CRYPTOCURRENCY LIVE SYNC WORKER      ');
  console.log('====================================================\n');
  console.log(`Connecting to live OFAC feed: ${OFAC_CSV_FEED}...`);

  let csvText;
  try {
    const res = await fetch(OFAC_CSV_FEED, {
      headers: { 'User-Agent': 'Patronage-Compliance-Worker/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    csvText = await res.text();
    console.log(`✔ Successfully retrieved OFAC SDN feed (${csvText.length} bytes)`);
  } catch (err) {
    console.warn(`⚠️ Warning: Failed to fetch live OFAC feed: ${err.message}`);
    if (fs.existsSync(CACHE_FILE)) {
      console.log(`ℹ Falling back to local offline cache: ${CACHE_FILE}`);
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      updateSanctionsList(cached.addresses, 'cached-offline-fallback');
      return { success: true, count: cached.addresses.length, source: 'offline-cache' };
    }
    throw new Error(`Unable to fetch live sanctions feed and no local cache available: ${err.message}`);
  }

  // Parse CSV
  const lines = csvText.split('\n');
  const addresses = [];
  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // CSV format: address,name (name may be quoted)
    const match = line.match(/^(0x[a-fA-F0-9]{40}),?(.*)$/);
    if (match) {
      const addr = match[1].toLowerCase();
      const entity = match[2] ? match[2].replace(/^"|"$/g, '').trim() : 'OFAC SDN Blocked Entity';
      addresses.push(addr);
      entries.push({ address: addr, entity });
    }
  }

  if (addresses.length === 0) {
    throw new Error('Parsed 0 addresses from live OFAC feed — format may have changed.');
  }

  // Save to cache file
  const cachePayload = {
    updatedAt: new Date().toISOString(),
    source: OFAC_CSV_FEED,
    count: addresses.length,
    addresses,
    entries,
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cachePayload, null, 2));
  console.log(`✔ Persisted ${addresses.length} sanctioned Ethereum addresses to ${CACHE_FILE}`);

  // Update active in-memory set
  const metadata = updateSanctionsList(addresses, 'ultrasoundmoney-ofac-live-feed');
  console.log(`✔ Active sanctions checker updated: ${metadata.totalCount} total blocked addresses`);
  console.log(`  Last Sync Timestamp: ${metadata.lastSyncAt}`);
  console.log(`  Live Feed Connected: ${metadata.isLiveFeedConnected}`);

  console.log('\n--- SAMPLE SANCTIONED ENTRIES DETECTED ---');
  entries.slice(0, 3).forEach((e, idx) => {
    console.log(`  [${idx + 1}] ${e.address} => ${e.entity}`);
  });
  console.log('------------------------------------------\n');

  console.log('====================================================');
  console.log(' ✔ OFAC SANCTIONS SYNC COMPLETED SUCCESSFULLY!');
  console.log('====================================================\n');

  return { success: true, count: addresses.length, metadata };
}

if (process.argv[1] && process.argv[1].endsWith('sync-sanctions.mjs')) {
  syncSanctionsFeed().catch((err) => {
    console.error('Sanctions sync failed:', err);
    process.exit(1);
  });
}
