import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http as viemHttp } from 'viem';
import { foundry } from 'viem/chains';
import { createSiweMessage } from '../../src/auth/siwe.mjs';

const API_BASE = 'http://127.0.0.1:8787';
const rpcClient = createPublicClient({ chain: foundry, transport: viemHttp('http://127.0.0.1:8545') });

function requestHttp(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, API_BASE);
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (c) => { resBody += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, raw: resBody, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  console.log('================================================================');
  console.log('       RED TEAM AUDIT: EIP-712 VOUCHER & LAZY MINT ATTACKS      ');
  console.log('================================================================\n');

  const vulnerabilities = [];
  const attacker = privateKeyToAccount('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'); // Account 3
  const victimArtist = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // Account 1

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 1: Unauthenticated POST /api/vouchers
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [ATTACK 1] Testing Unauthenticated POST /api/vouchers Injection...');
  const fakeVoucher = {
    chainId: 31337,
    nftAddress: '0x1111111111111111111111111111111111111111',
    tokenId: '99999',
    minPriceWei: '100000000000000000', // 0.1 ETH
    metadataUri: 'ipfs://fake-ipfs-uri',
    artist: victimArtist.address,
    nonce: 1,
    deadline: Math.floor(Date.now() / 1000) + 86400,
    signature: '0x' + '00'.repeat(65), // Invalid bogus signature
    title: 'Untrusted Voucher Test Fixture',
    artistName: 'Fixture Artist',
  };

  const unauthRes = await requestHttp('POST', '/api/vouchers', fakeVoucher);

  if (unauthRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Unauthenticated user injected bogus voucher into marketplace database!');
    vulnerabilities.push({
      id: 'VOUCHER-API-UNAUTHENTICATED-INJECTION',
      severity: 'HIGH',
      desc: 'POST /api/vouchers allows unauthenticated injection of unverified vouchers without signature validation.',
    });
  } else {
    console.log('  ✔ Unauthenticated voucher injection rejected (HTTP', unauthRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 2: Expired Voucher Submission
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 2] Testing Already-Expired Voucher Submission...');
  const expiredVoucher = {
    ...fakeVoucher,
    tokenId: '99998',
    nonce: 2,
    deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour in past
  };

  const expiredRes = await requestHttp('POST', '/api/vouchers', expiredVoucher);
  if (expiredRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: API accepted already-expired voucher!');
    vulnerabilities.push({
      id: 'VOUCHER-API-EXPIRED-ACCEPTED',
      severity: 'MEDIUM',
      desc: 'POST /api/vouchers accepted a voucher with a deadline in the past.',
    });
  } else {
    console.log('  ✔ Expired voucher rejected (HTTP', expiredRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 3: Forged Signature Acceptance
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 3] Testing Forged Signature Acceptance in API...');
  const forgedVoucher = {
    ...fakeVoucher,
    tokenId: '99997',
    nonce: 3,
    artist: victimArtist.address, // Claim victim is artist
    signature: await attacker.signMessage({ message: 'Forged message' }), // Signed by attacker, not victim
  };

  const forgedRes = await requestHttp('POST', '/api/vouchers', forgedVoucher);
  if (forgedRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: API accepted voucher signed by third party without cryptographic verification against artist!');
    vulnerabilities.push({
      id: 'VOUCHER-API-SIGNATURE-NOT-VERIFIED',
      severity: 'HIGH',
      desc: 'POST /api/vouchers does not verify EIP-712 signature against declared artist address.',
    });
  } else {
    console.log('  ✔ Forged voucher rejected (HTTP', forgedRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 4: Authenticated Session with Spoofed Artist Address
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 4] Testing Authenticated Attacker Submitting Voucher for Another Artist...');
  const nonceRes = await requestHttp('GET', '/api/siwe/nonce');
  const attackerNonce = nonceRes.data.nonce;
  const siweMsg = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: attacker.address,
    statement: 'Sign in to Patronage.',
    uri: 'http://127.0.0.1:8787',
    version: '1',
    chainId: 31337,
    nonce: attackerNonce,
    issuedAt: new Date().toISOString(),
  });
  const attackerSig = await attacker.signMessage({ message: siweMsg });
  const authRes = await requestHttp('POST', '/api/siwe/verify', {
    address: attacker.address,
    message: siweMsg,
    signature: attackerSig,
    nonce: attackerNonce,
  });

  const attackerToken = authRes.data.session.token;
  const spoofedArtistRes = await requestHttp('POST', '/api/vouchers', fakeVoucher, {
    Authorization: `Bearer ${attackerToken}`,
  });

  if (spoofedArtistRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Authenticated user spoofed another artist on voucher submission!');
    vulnerabilities.push({
      id: 'VOUCHER-API-ARTIST-SPOOFING',
      severity: 'HIGH',
      desc: 'POST /api/vouchers allows authenticated user to submit voucher claiming to be another artist.',
    });
  } else {
    console.log('  ✔ Spoofed artist submission rejected (HTTP', spoofedArtistRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 5: Authenticated Session with Expired Voucher
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 5] Testing Authenticated Submission of Expired Voucher...');
  const authExpiredRes = await requestHttp('POST', '/api/vouchers', {
    ...expiredVoucher,
    artist: attacker.address,
  }, {
    Authorization: `Bearer ${attackerToken}`,
  });

  if (authExpiredRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: API accepted expired voucher from authenticated user!');
    vulnerabilities.push({
      id: 'VOUCHER-API-EXPIRED-ACCEPTED',
      severity: 'MEDIUM',
      desc: 'POST /api/vouchers accepted expired voucher from authenticated user.',
    });
  } else {
    console.log('  ✔ Authenticated expired voucher rejected (HTTP', authExpiredRes.status, ')');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 6: Authenticated Session with Invalid EIP-712 Signature
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 6] Testing Authenticated Submission with Invalid EIP-712 Signature...');
  const invalidSigRes = await requestHttp('POST', '/api/vouchers', {
    ...fakeVoucher,
    artist: attacker.address,
    deadline: Math.floor(Date.now() / 1000) + 86400,
  }, {
    Authorization: `Bearer ${attackerToken}`,
  });

  if (invalidSigRes.status === 201) {
    console.log('  🚨 VULNERABILITY REPRODUCED: API accepted invalid EIP-712 signature!');
    vulnerabilities.push({
      id: 'VOUCHER-API-SIGNATURE-NOT-VERIFIED',
      severity: 'HIGH',
      desc: 'POST /api/vouchers accepted invalid signature from authenticated user.',
    });
  } else {
    console.log('  ✔ Invalid EIP-712 signature rejected (HTTP', invalidSigRes.status, ')');
  }

  console.log('\n================================================================');
  console.log(` RED TEAM VOUCHER AUDIT FINISHED: ${vulnerabilities.length} VULNERABILITIES IDENTIFIED`);
  console.log('================================================================');
  return vulnerabilities;
}

main().then((vulns) => {
  if (vulns.length > 0) {
    console.log('Vulnerabilities to fix:', vulns);
  }
}).catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
