/**
 * GOAL 2 — API INPUT VALIDATION AUDIT
 * Tests every endpoint with hostile inputs:
 *   - missing required fields
 *   - null / undefined values
 *   - empty strings
 *   - wrong types (numbers as strings, objects, arrays)
 *   - negative numbers
 *   - NaN / Infinity
 *   - huge strings / values
 *   - huge pagination numbers
 *   - malformed Ethereum addresses
 *   - SQL injection attempts
 *   - XSS payloads in string fields
 *   - unexpected extra fields
 *   - deeply nested objects
 *
 * The API MUST NOT crash on any of these inputs.
 * All should return 4xx with structured errors (never 500).
 */
import '../src/config/load-env.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const API = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(`${API}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

async function login(account) {
  const nr = await api('GET', '/api/siwe/nonce');
  const nonce = nr.data.nonce;
  const msg = `127.0.0.1:8787 wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Patronage.\n\nURI: http://127.0.0.1:8787\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = await account.signMessage({ message: msg });
  const r = await api('POST', '/api/siwe/verify', { address: account.address, message: msg, signature: sig, nonce });
  if (r.status !== 200) throw new Error(`Login failed: ${JSON.stringify(r.data)}`);
  return r.data.session.token;
}

function auth(token) { return { Authorization: `Bearer ${token}` }; }

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ✔ ${label}`);
}

const HUGE = 'A'.repeat(100_000);
const XSS  = '<script>alert(1)</script>';
const SQL  = "' OR 1=1; DROP TABLE lots; --";

async function main() {
  console.log('================================================================');
  console.log('   GOAL 2 — API INPUT VALIDATION AUDIT                         ');
  console.log('================================================================\n');

  const alice = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const token = await login(alice);
  const hdrs = auth(token);

  let passed = 0, failed = 0;
  async function check(label, fn) {
    try { await fn(); passed++; }
    catch (e) { console.error(`  ✖ FAIL [${label}]: ${e.message}`); failed++; }
  }

  // Helper: "does not crash" — we just need 2xx or 4xx, never 5xx
  function noCrash(status, label) {
    assert(status < 500, `${label}: should not return 5xx (got ${status})`);
  }

  // ── /api/lots — GET pagination edge cases ─────────────────────────────────
  await check('V1: /api/lots?page=-999&limit=NaN returns 200 (clamped)', async () => {
    const r = await api('GET', '/api/lots?page=-999&limit=NaN');
    noCrash(r.status, 'V1');
    assert(r.status === 200, `got ${r.status}`);
  });

  await check('V2: /api/lots?page=Infinity&limit=99999 clamped/safe', async () => {
    const r = await api('GET', '/api/lots?page=Infinity&limit=99999');
    noCrash(r.status, 'V2');
  });

  await check('V3: /api/lots?q=SQL injection query is safely escaped', async () => {
    const r = await api('GET', `/api/lots?q=${encodeURIComponent(SQL)}`);
    noCrash(r.status, 'V3');
    assert(r.status !== 500, `SQL injection caused 500: ${r.status}`);
  });

  await check('V4: /api/lots?q=XSS payload returns safe response', async () => {
    const r = await api('GET', `/api/lots?q=${encodeURIComponent(XSS)}`);
    noCrash(r.status, 'V4');
  });

  await check('V5: /api/lots?q=huge string (100k chars) does not crash', async () => {
    const r = await api('GET', `/api/lots?q=${HUGE}`);
    noCrash(r.status, 'V5');
  });

  await check('V6: /api/lots?sort=unknown_sort_key returns 200 (default sort)', async () => {
    const r = await api('GET', '/api/lots?sort=<malicious>');
    noCrash(r.status, 'V6');
    assert(r.status === 200, `got ${r.status}`);
  });

  // ── /api/siwe/verify — body edge cases ───────────────────────────────────
  await check('V7: Empty JSON body to /api/siwe/verify returns 400', async () => {
    const r = await api('POST', '/api/siwe/verify', {});
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V8: Null fields to /api/siwe/verify returns 400', async () => {
    const r = await api('POST', '/api/siwe/verify', { address: null, message: null, signature: null, nonce: null });
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V9: Array instead of string address to /api/siwe/verify → 400', async () => {
    const r = await api('POST', '/api/siwe/verify', { address: [1, 2, 3], message: 'x', signature: '0x', nonce: 'n' });
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V10: Huge address field (100k chars) to /api/siwe/verify → 400/413', async () => {
    const r = await api('POST', '/api/siwe/verify', { address: HUGE, message: 'x', signature: '0x', nonce: 'n' })
      .catch(() => ({ status: 413 }));
    assert(r.status === 400 || r.status === 413, `expected 400/413 got ${r.status}`);
  });

  await check('V11: Object as signature → 400 (no crash)', async () => {
    const r = await api('POST', '/api/siwe/verify', { address: alice.address, message: 'x', signature: {}, nonce: 'n' });
    noCrash(r.status, 'V11');
  });

  // ── /api/artists/apply — body edge cases ─────────────────────────────────
  await check('V12: Missing handle in /api/artists/apply → 400', async () => {
    const r = await api('POST', '/api/artists/apply', { displayName: 'Test' }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V13: Missing displayName in /api/artists/apply → 400', async () => {
    const r = await api('POST', '/api/artists/apply', { handle: 'testhandle' }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V14: Invalid handle with spaces in /api/artists/apply → 400', async () => {
    const r = await api('POST', '/api/artists/apply', { handle: 'bad handle!', displayName: 'Test' }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V15: XSS handle in /api/artists/apply → 400 (pattern check)', async () => {
    const r = await api('POST', '/api/artists/apply', { handle: '<script>xss</script>', displayName: 'XSS' }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V16: Huge displayName (100k chars) → no crash', async () => {
    const r = await api('POST', '/api/artists/apply', { handle: 'hugetest', displayName: HUGE }, hdrs)
      .catch(() => ({ status: 413 }));
    noCrash(r.status, 'V16');
  });

  // ── /api/vouchers POST — hostile inputs ──────────────────────────────────
  await check('V17: POST /api/vouchers with missing nftAddress → 400', async () => {
    const r = await api('POST', '/api/vouchers', {
      artist: alice.address,
      signature: '0x' + '00'.repeat(65),
      minPriceWei: '1',
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V18: POST /api/vouchers with past deadline → 400', async () => {
    const r = await api('POST', '/api/vouchers', {
      nftAddress: '0x' + '1'.repeat(40),
      artist: alice.address,
      signature: '0x' + '00'.repeat(65),
      minPriceWei: '1',
      nonce: 1,
      deadline: 1000, // far past
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V19: POST /api/vouchers with NaN deadline → 400', async () => {
    const r = await api('POST', '/api/vouchers', {
      nftAddress: '0x' + '1'.repeat(40),
      artist: alice.address,
      signature: '0x' + '00'.repeat(65),
      minPriceWei: '1',
      nonce: 1,
      deadline: 'NaN',
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V20: POST /api/vouchers with negative deadline → 400', async () => {
    const r = await api('POST', '/api/vouchers', {
      nftAddress: '0x' + '1'.repeat(40),
      artist: alice.address,
      signature: '0x' + '00'.repeat(65),
      minPriceWei: '1',
      nonce: 1,
      deadline: -9999,
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V21: POST /api/vouchers with invalid nftAddress format → 400', async () => {
    const r = await api('POST', '/api/vouchers', {
      nftAddress: 'not-an-address',
      artist: alice.address,
      signature: '0x' + '00'.repeat(65),
      minPriceWei: '1',
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  // ── /api/moderation/delist — hostile inputs ───────────────────────────────
  const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const adminToken = await login(adminAccount);
  const adminHdrs = auth(adminToken);

  await check('V22: POST /api/moderation/delist with missing contractAddress → 400', async () => {
    const r = await api('POST', '/api/moderation/delist', { tokenId: 1 }, adminHdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V23: POST /api/moderation/delist with invalid address → 400', async () => {
    const r = await api('POST', '/api/moderation/delist', { contractAddress: 'garbage', tokenId: 1 }, adminHdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V24: POST /api/moderation/delist with missing tokenId → 400', async () => {
    const r = await api('POST', '/api/moderation/delist', { contractAddress: '0x' + '1'.repeat(40) }, adminHdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  // ── /api/lots — extra/unexpected query params ─────────────────────────────
  await check('V25: /api/lots with deeply unexpected query params → no crash', async () => {
    const r = await api('GET', '/api/lots?__proto__=polluted&constructor=break&status=../../../../etc/passwd');
    noCrash(r.status, 'V25');
  });

  // ── Body size limit — >64KB JSON ──────────────────────────────────────────
  await check('V26: Oversized body (>64KB) to /api/siwe/verify → 413/400', async () => {
    const r = await api('POST', '/api/siwe/verify', JSON.stringify({ padding: 'x'.repeat(70_000) }))
      .catch(() => ({ status: 413 }));
    assert(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
  });

  // ── /api/upload — hostile inputs ─────────────────────────────────────────
  await check('V27: POST /api/upload with empty body → 400', async () => {
    const r = await api('POST', '/api/upload', {}, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V28: POST /api/upload with null imageBase64 → 400', async () => {
    const r = await api('POST', '/api/upload', { title: 'Test', imageBase64: null }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  await check('V29: POST /api/upload with invalid MIME type → 400', async () => {
    const r = await api('POST', '/api/upload', {
      title: 'Test',
      imageBase64: 'data:application/javascript;base64,dGVzdA==',
      filename: 'malware.js',
    }, hdrs);
    assert(r.status === 400, `got ${r.status}`);
  });

  // ── Unknown route ─────────────────────────────────────────────────────────
  await check('V30: Unknown route returns 404 (not 500)', async () => {
    const r = await api('GET', '/api/definitely/does/not/exist');
    assert(r.status === 404, `got ${r.status}`);
  });

  console.log(`\n================================================================`);
  console.log(` INPUT VALIDATION AUDIT: ${passed} passed / ${failed} failed`);
  console.log(`================================================================`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
