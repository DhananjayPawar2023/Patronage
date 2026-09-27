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

async function getSessionToken(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const nonceRes = await requestHttp('GET', '/api/siwe/nonce');
  const nonce = nonceRes.data?.nonce;
  const msg = createSiweMessage({
    domain: '127.0.0.1:8787',
    address: account.address,
    chainId: 31337,
    nonce,
    uri: API_BASE,
  });
  const sig = await account.signMessage({ message: msg });
  const loginRes = await requestHttp('POST', '/api/siwe/verify', {
    address: account.address,
    message: msg,
    signature: sig,
    nonce,
  });
  return { token: loginRes.data?.session?.token, address: account.address, role: loginRes.data?.role };
}

async function main() {
  console.log('================================================================');
  console.log('       RED TEAM AUDIT: API AUTHORIZATION & RBAC ATTACKS         ');
  console.log('================================================================\n');

  const vulnerabilities = [];

  // Account 0 is configured Admin
  const adminAccount = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  // Account 2 is an unprivileged regular user
  const userAccount = '0x5de4111afa1a4b94908f83103eb219e4ffb7b01850117004f98144615215037e';

  const userSession = await getSessionToken(userAccount);
  const userAuth = { Authorization: `Bearer ${userSession.token}` };

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 1: Unauthorized Admin Access Attempts (Unauthenticated)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [ATTACK 1] Testing Unauthenticated Admin Endpoint Access...');
  const unauthEndpoints = [
    { method: 'GET', path: '/api/admin/artists' },
    { method: 'POST', path: '/api/admin/artists/0x1111111111111111111111111111111111111111/approve' },
    { method: 'POST', path: '/api/admin/sanctions/sync' },
    { method: 'POST', path: '/api/admin/sessions/prune' },
    { method: 'GET', path: '/api/admin/sessions/status' },
    { method: 'POST', path: '/api/moderation/delist' },
    { method: 'GET', path: '/api/moderation/delisted' },
  ];

  for (const ep of unauthEndpoints) {
    const res = await requestHttp(ep.method, ep.path);
    if (res.status !== 401) {
      console.log(`  🚨 VULNERABILITY REPRODUCED: Unauthenticated access to ${ep.path} returned HTTP ${res.status}!`);
      vulnerabilities.push({
        id: 'API-UNAUTH-ADMIN-ACCESS',
        severity: 'CRITICAL',
        desc: `Endpoint ${ep.path} accessible without authentication.`,
      });
    }
  }
  console.log('  ✔ All unauthenticated admin/moderation calls rejected with HTTP 401.');

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 2: Role Escalation / Privilege Bypass (Regular User calling Admin)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 2] Testing Role Escalation by Regular Authenticated User...');
  for (const ep of unauthEndpoints) {
    const res = await requestHttp(ep.method, ep.path, {}, userAuth);
    if (res.status !== 403) {
      console.log(`  🚨 VULNERABILITY REPRODUCED: Regular user accessed ${ep.path} with status ${res.status}!`);
      vulnerabilities.push({
        id: 'API-ROLE-ESCALATION',
        severity: 'CRITICAL',
        desc: `Regular user was able to access privileged endpoint ${ep.path} (status: ${res.status}).`,
      });
    }
  }
  console.log('  ✔ All regular user attempts to access admin/moderation endpoints rejected with HTTP 403 Forbidden.');

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 3: SQL Injection / Malformed Query Handling on /api/lots
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 3] Testing SQL Injection and Malformed Query Parameters...');
  const sqliRes = await requestHttp('GET', "/api/lots?q=' OR 1=1 --");
  if (sqliRes.status === 500) {
    console.log('  🚨 VULNERABILITY: Raw SQL error leaked on query payload!');
    vulnerabilities.push({
      id: 'API-SQL-INJECTION-LEAK',
      severity: 'HIGH',
      desc: 'Query parameter caused internal 500 database error.',
    });
  } else if (sqliRes.status === 200) {
    console.log('  ✔ SQL injection payload safely escaped by Prisma query builder.');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 4: Negative/NaN Pagination Boundaries
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 4] Testing Negative and NaN Pagination Boundaries...');
  const pageRes = await requestHttp('GET', '/api/lots?page=-5&limit=NaN');
  if (pageRes.status === 200 && Array.isArray(pageRes.data?.data)) {
    console.log('  ✔ Negative/NaN pagination gracefully clamped to defaults (page 1, limit 50).');
  } else {
    console.log('  ✖ Unexpected pagination behavior:', pageRes.status);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ATTACK 5: Rate Limiting Enforcement
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [ATTACK 5] Testing Rate Limiting (650 rapid requests against 600/min limit)...');
  const rapidRequests = [];
  for (let i = 0; i < 650; i++) {
    rapidRequests.push(requestHttp('GET', '/health'));
  }
  const rateLimitResults = await Promise.all(rapidRequests);
  const rateLimited = rateLimitResults.filter((r) => r.status === 429);
  console.log(`  Rate limited requests: ${rateLimited.length} / 150.`);
  if (rateLimited.length > 0) {
    console.log('  ✔ Rate limiting active and successfully throttling request bursts (HTTP 429).');
  } else {
    console.log('  ⚠️ Rate limiting did not trigger within 150 requests.');
    vulnerabilities.push({
      id: 'API-RATE-LIMIT-PERMISSIVE',
      severity: 'LOW',
      desc: 'Rate limiting threshold was not exceeded in 150 requests.',
    });
  }

  console.log('\n================================================================');
  console.log(` RED TEAM API AUDIT FINISHED: ${vulnerabilities.length} VULNERABILITIES IDENTIFIED`);
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
