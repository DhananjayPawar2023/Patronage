/**
 * GOAL 2 — AUTH AUDIT
 * Tests every edge case of the SIWE authentication flow:
 *   - invalid signature
 *   - altered message fields (domain, URI, chainId)
 *   - expired nonce
 *   - reused nonce
 *   - concurrent nonce consumption (replay race)
 *   - wrong-wallet signature
 *   - session substitution / bearer token forgery
 *   - logout / invalidation
 *   - missing body fields
 */
import '../src/config/load-env.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const API = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';

async function api(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${API}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

async function freshNonce() {
  const r = await api('GET', '/api/siwe/nonce');
  if (!r.data.nonce) throw new Error('Failed to get nonce');
  return r.data.nonce;
}

function siweMsg(account, nonce, { domain, chainId, uri, issuedAt } = {}) {
  const d = domain   ?? '127.0.0.1:8787';
  const c = chainId  ?? 31337;
  const u = uri      ?? 'http://127.0.0.1:8787';
  const ia = issuedAt ?? new Date().toISOString();
  return `${d} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Patronage.\n\nURI: ${u}\nVersion: 1\nChain ID: ${c}\nNonce: ${nonce}\nIssued At: ${ia}`;
}

async function validLogin(account) {
  const nonce = await freshNonce();
  const msg = siweMsg(account, nonce);
  const sig = await account.signMessage({ message: msg });
  return api('POST', '/api/siwe/verify', { address: account.address, message: msg, signature: sig, nonce });
}

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ✔ ${label}`);
}

async function main() {
  console.log('================================================================');
  console.log('   GOAL 2 — AUTHENTICATION EDGE-CASE AUDIT                     ');
  console.log('================================================================\n');

  const wallet  = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const wallet2 = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
  let passed = 0, failed = 0;

  async function check(label, fn) {
    try { await fn(); passed++; }
    catch (e) { console.error(`  ✖ FAIL [${label}]: ${e.message}`); failed++; }
  }

  // ── A1: Valid login succeeds ──────────────────────────────────────────────
  await check('A1: Valid SIWE login returns 200 + session token', async () => {
    const r = await validLogin(wallet);
    assert(r.status === 200, `got HTTP ${r.status}`);
    assert(typeof r.data.session?.token === 'string', 'session token present');
  });

  // ── A2: Invalid (malformed) signature ────────────────────────────────────
  await check('A2: Malformed signature rejected (400/401)', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet, nonce);
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: '0x' + 'ab'.repeat(65),
      nonce,
    });
    assert(r.status === 400 || r.status === 401, `expected 400/401 got ${r.status}`);
  });

  // ── A3: Wrong-wallet signature (signature from wallet2, address wallet) ──
  await check('A3: Wrong-wallet signature rejected (400/401)', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet, nonce);
    const sig = await wallet2.signMessage({ message: msg }); // signed by wallet2 but address=wallet
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce,
    });
    assert(r.status === 400 || r.status === 401, `expected 400/401 got ${r.status}`);
  });

  // ── A4: Altered domain ────────────────────────────────────────────────────
  await check('A4: Altered domain in SIWE message rejected', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet, nonce, { domain: 'evil.attacker.io' });
    const sig = await wallet.signMessage({ message: msg });
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A5: Altered URI ───────────────────────────────────────────────────────
  await check('A5: Altered URI in SIWE message rejected (valid domain, evil URI)', async () => {
    const nonce = await freshNonce();
    // Use valid domain but evil URI — tests URI allowlist specifically
    const msg = siweMsg(wallet, nonce, { domain: '127.0.0.1:8787', uri: 'http://evil.attacker.io' });
    const sig = await wallet.signMessage({ message: msg });
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A6: Altered chainId ───────────────────────────────────────────────────
  await check('A6: Wrong chain ID in SIWE message rejected', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet, nonce, { chainId: 1 }); // mainnet
    const sig = await wallet.signMessage({ message: msg });
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A7: Expired/unknown nonce ─────────────────────────────────────────────
  await check('A7: Unknown/expired nonce rejected', async () => {
    const fakeNonce = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const msg = siweMsg(wallet, fakeNonce);
    const sig = await wallet.signMessage({ message: msg });
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce: fakeNonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A8: Nonce reuse (replay) ──────────────────────────────────────────────
  await check('A8: Nonce reuse rejected on second submission', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet, nonce);
    const sig = await wallet.signMessage({ message: msg });
    const payload = { address: wallet.address, message: msg, signature: sig, nonce };
    const r1 = await api('POST', '/api/siwe/verify', payload);
    const r2 = await api('POST', '/api/siwe/verify', payload);
    assert(r1.status === 200, `first login got ${r1.status}`);
    assert(r2.status === 400, `replay got ${r2.status} (expected 400)`);
  });

  // ── A9: Concurrent nonce consumption (race — only 1 succeeds) ─────────────
  await check('A9: Concurrent nonce consumption — only 1 of 50 succeeds', async () => {
    const nonce = await freshNonce();
    const msg = siweMsg(wallet2, nonce);
    const sig = await wallet2.signMessage({ message: msg });
    const payload = { address: wallet2.address, message: msg, signature: sig, nonce };
    const results = await Promise.all(Array.from({ length: 50 }, () =>
      api('POST', '/api/siwe/verify', payload)
    ));
    const successes = results.filter(r => r.status === 200);
    assert(successes.length <= 1, `Expected at most 1 success, got ${successes.length}`);
  });

  // ── A10: Missing address field ────────────────────────────────────────────
  await check('A10: Missing address field returns 400', async () => {
    const nonce = await freshNonce();
    const r = await api('POST', '/api/siwe/verify', { message: 'x', signature: '0x', nonce });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A11: Missing message field ────────────────────────────────────────────
  await check('A11: Missing message field returns 400', async () => {
    const nonce = await freshNonce();
    const r = await api('POST', '/api/siwe/verify', { address: wallet.address, signature: '0x', nonce });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A12: Missing signature field ──────────────────────────────────────────
  await check('A12: Missing signature field returns 400', async () => {
    const nonce = await freshNonce();
    const r = await api('POST', '/api/siwe/verify', { address: wallet.address, message: 'x', nonce });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A13: Malformed JSON body ──────────────────────────────────────────────
  await check('A13: Malformed JSON body returns 400', async () => {
    const r = await fetch(`${API}/api/siwe/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json}}',
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A14: Invalid Ethereum address format ──────────────────────────────────
  await check('A14: Invalid Ethereum address format returns 400', async () => {
    const nonce = await freshNonce();
    const r = await api('POST', '/api/siwe/verify', {
      address: 'not-an-address',
      message: 'test',
      signature: '0x',
      nonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A15: Future-dated issuedAt rejected ───────────────────────────────────
  await check('A15: Future-dated issuedAt (+1h) rejected', async () => {
    const nonce = await freshNonce();
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const msg = siweMsg(wallet, nonce, { issuedAt: futureIso });
    const sig = await wallet.signMessage({ message: msg });
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: msg,
      signature: sig,
      nonce,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A16: Logout invalidates session ──────────────────────────────────────
  await check('A16: Logout invalidates bearer token', async () => {
    const login = await validLogin(wallet2);
    assert(login.status === 200, 'login ok');
    const token = login.data.session.token;

    // Confirm it works before logout
    const before = await api('GET', '/api/notifications', undefined, { Authorization: `Bearer ${token}` });
    assert(before.status === 200, `pre-logout ${before.status}`);

    // Logout
    const logout = await api('POST', '/api/siwe/logout', undefined, { Authorization: `Bearer ${token}` });
    assert(logout.status === 200, `logout ${logout.status}`);

    // Confirm it's rejected after logout
    const after = await api('GET', '/api/notifications', undefined, { Authorization: `Bearer ${token}` });
    assert(after.status === 401, `post-logout got ${after.status} (expected 401)`);
  });

  // ── A17: Session substitution (forged bearer token) ──────────────────────
  await check('A17: Forged bearer token rejected with 401', async () => {
    const r = await api('GET', '/api/notifications', undefined, {
      Authorization: 'Bearer ' + 'a'.repeat(64),
    });
    assert(r.status === 401, `expected 401 got ${r.status}`);
  });

  // ── A18: Nonce generation rate-limit not bypass via fast burst ────────────
  await check('A18: SIWE nonce endpoint survives 100-request burst without crashing', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => api('GET', '/api/siwe/nonce'))
    );
    const ok = results.filter(r => r.status === 200).length;
    assert(ok >= 10, `at least 10 nonces returned, got ${ok}`);
  });

  // ── A19: Empty string nonce ───────────────────────────────────────────────
  await check('A19: Empty string nonce rejected', async () => {
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: 'msg',
      signature: '0x',
      nonce: '',
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  // ── A20: Null nonce ───────────────────────────────────────────────────────
  await check('A20: Null nonce rejected', async () => {
    const r = await api('POST', '/api/siwe/verify', {
      address: wallet.address,
      message: 'msg',
      signature: '0x',
      nonce: null,
    });
    assert(r.status === 400, `expected 400 got ${r.status}`);
  });

  console.log(`\n================================================================`);
  console.log(` AUTH AUDIT: ${passed} passed / ${failed} failed`);
  console.log(`================================================================`);

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
