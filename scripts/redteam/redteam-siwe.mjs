import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from '../../src/auth/siwe.mjs';

const API_BASE = 'http://127.0.0.1:8787';

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
  console.log('       RED TEAM AUDIT: SIWE & SESSION ATTACK SUITE              ');
  console.log('================================================================\n');

  const testAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const vulnerabilities = [];

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 1: Host Header Spoofing / Domain Whitelist Bypass
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [ATTACK 1] Testing Host Header Injection / Arbitrary Domain Spoofing...');
  try {
    const nonceRes = await requestHttp('GET', '/api/siwe/nonce');
    const nonce = nonceRes.data?.nonce;
    const evilDomain = 'attacker-controlled-phishing.xyz';
    const evilMessage = createSiweMessage({
      domain: evilDomain,
      address: testAccount.address,
      chainId: 31337,
      nonce,
      uri: `http://${evilDomain}`,
    });
    const evilSignature = await testAccount.signMessage({ message: evilMessage });

    // Submit with spoofed Host header
    const spoofRes = await requestHttp('POST', '/api/siwe/verify', {
      address: testAccount.address,
      message: evilMessage,
      signature: evilSignature,
      nonce,
    }, {
      'Host': evilDomain,
    });

    if (spoofRes.status === 200) {
      console.log('  🚨 VULNERABILITY REPRODUCED: Server trusted untrusted Host header and accepted evil.xyz domain!');
      vulnerabilities.push({
        id: 'SIWE-HOST-INJECTION',
        severity: 'HIGH',
        desc: 'SIWE verification accepts arbitrary domains if client supplies matching Host header.',
      });
    } else {
      console.log('  ✔ Host header injection rejected:', spoofRes.data?.error?.message || spoofRes.status);
    }
  } catch (err) {
    console.log('  ✔ Attack error/rejection:', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 2: 100 Concurrent Verification Requests (Nonce Race Condition)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 2] Testing 100 Concurrent SIWE Verification Requests...');
  const nonceRes2 = await requestHttp('GET', '/api/siwe/nonce');
  const nonce2 = nonceRes2.data?.nonce;
  const msg2 = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: testAccount.address,
    chainId: 31337,
    nonce: nonce2,
    uri: 'http://127.0.0.1:8787',
  });
  const sig2 = await testAccount.signMessage({ message: msg2 });

  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(requestHttp('POST', '/api/siwe/verify', {
      address: testAccount.address,
      message: msg2,
      signature: sig2,
      nonce: nonce2,
    }));
  }

  const results = await Promise.all(promises);
  const successes = results.filter((r) => r.status === 200);
  const failures = results.filter((r) => r.status !== 200);
  console.log(`  Results: ${successes.length} accepted, ${failures.length} rejected out of 100.`);

  if (successes.length > 1) {
    console.log(`  🚨 VULNERABILITY REPRODUCED: Nonce consumed ${successes.length} times under concurrent load!`);
    vulnerabilities.push({
      id: 'SIWE-CONCURRENCY-RACE',
      severity: 'CRITICAL',
      desc: `Nonce was consumed ${successes.length} times in parallel.`,
    });
  } else if (successes.length === 1) {
    console.log('  ✔ Nonce concurrency strictly atomic: exactly 1 accepted, 99 rejected.');
  } else {
    console.log('  ✖ All 100 requests rejected (unexpected failure).');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 3: Cross-Chain SIWE Signature Replay
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 3] Testing Cross-Chain SIWE Signature Submission (Chain 1 -> 31337)...');
  const nonceRes3 = await requestHttp('GET', '/api/siwe/nonce');
  const nonce3 = nonceRes3.data?.nonce;
  const crossChainMsg = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: testAccount.address,
    chainId: 1, // Mainnet
    nonce: nonce3,
    uri: 'http://127.0.0.1:8787',
  });
  const crossChainSig = await testAccount.signMessage({ message: crossChainMsg });

  const crossChainRes = await requestHttp('POST', '/api/siwe/verify', {
    address: testAccount.address,
    message: crossChainMsg,
    signature: crossChainSig,
    nonce: nonce3,
  });

  if (crossChainRes.status === 200) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Mainnet signature accepted on Chain 31337!');
    vulnerabilities.push({
      id: 'SIWE-CROSS-CHAIN-REPLAY',
      severity: 'CRITICAL',
      desc: 'Server accepted signature issued for Chain ID 1.',
    });
  } else {
    console.log('  ✔ Cross-chain signature rejected:', crossChainRes.data?.error?.message || crossChainRes.status);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 4: Future-Dated and Expired Timestamps
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 4] Testing Timestamp Manipulation Attacks...');
  const nonceRes4 = await requestHttp('GET', '/api/siwe/nonce');
  const nonce4 = nonceRes4.data?.nonce;
  const futureMsg = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: testAccount.address,
    chainId: 31337,
    nonce: nonce4,
    uri: 'http://127.0.0.1:8787',
    issuedAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour in future
  });
  const futureSig = await testAccount.signMessage({ message: futureMsg });
  const futureRes = await requestHttp('POST', '/api/siwe/verify', {
    address: testAccount.address,
    message: futureMsg,
    signature: futureSig,
    nonce: nonce4,
  });

  if (futureRes.status === 200) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Future-dated (+1h) SIWE message accepted!');
    vulnerabilities.push({
      id: 'SIWE-FUTURE-TIMESTAMP',
      severity: 'HIGH',
      desc: 'Server accepted SIWE message with issuedAt 1 hour in the future.',
    });
  } else {
    console.log('  ✔ Future-dated message rejected:', futureRes.data?.error?.message || futureRes.status);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 5: Post-Logout Session Reuse Attack
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 5] Testing Post-Logout Session Reuse...');
  // Obtain fresh session
  const nonceRes5 = await requestHttp('GET', '/api/siwe/nonce');
  const nonce5 = nonceRes5.data?.nonce;
  const msg5 = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: testAccount.address,
    chainId: 31337,
    nonce: nonce5,
    uri: 'http://127.0.0.1:8787',
  });
  const sig5 = await testAccount.signMessage({ message: msg5 });
  const loginRes = await requestHttp('POST', '/api/siwe/verify', {
    address: testAccount.address,
    message: msg5,
    signature: sig5,
    nonce: nonce5,
  });
  const token = loginRes.data?.session?.token;

  // Test authenticated access works
  const preLogout = await requestHttp('GET', '/api/notifications', null, { Authorization: `Bearer ${token}` });
  if (preLogout.status !== 200) throw new Error(`Authenticated request failed: ${preLogout.status}`);

  // Logout
  const logoutRes = await requestHttp('POST', '/api/siwe/logout', null, { Authorization: `Bearer ${token}` });
  if (logoutRes.status !== 200) throw new Error('Logout request failed');

  // Attempt post-logout access
  const postLogout = await requestHttp('GET', '/api/notifications', null, { Authorization: `Bearer ${token}` });
  if (postLogout.status === 200) {
    console.log('  🚨 VULNERABILITY REPRODUCED: Revoked session token still valid after logout!');
    vulnerabilities.push({
      id: 'SESSION-REUSE-AFTER-LOGOUT',
      severity: 'HIGH',
      desc: 'Revoked session token can still access authenticated endpoints.',
    });
  } else {
    console.log('  ✔ Session properly invalidated on logout (returned HTTP', postLogout.status, ')');
  }

  console.log('\n================================================================');
  console.log(` RED TEAM SIWE AUDIT FINISHED: ${vulnerabilities.length} VULNERABILITIES IDENTIFIED`);
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
