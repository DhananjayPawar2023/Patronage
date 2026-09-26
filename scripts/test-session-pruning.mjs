import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { privateKeyToAccount } from 'viem/accounts';

const prisma = new PrismaClient();
const API_BASE = 'http://127.0.0.1:8787';

const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const userAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

async function loginAccount(account) {
  const nonceRes = await fetch(`${API_BASE}/api/siwe/nonce`);
  const { nonce } = await nonceRes.json();

  const msg = `127.0.0.1:8787 wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Patronage.\n\nURI: http://127.0.0.1:8787\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = await account.signMessage({ message: msg });

  const verifyRes = await fetch(`${API_BASE}/api/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address: account.address,
      message: msg,
      signature: sig,
      nonce,
    }),
  });

  const data = await verifyRes.json();
  return { token: data.session.token, role: data.role };
}

async function main() {
  console.log('====================================================');
  console.log('    TESTING SIWE SESSION PRUNING & MAINTENANCE      ');
  console.log('====================================================\n');

  // 1. Unauthenticated check
  console.log('▶ [1/4] Checking unauthenticated access to /api/admin/sessions/status...');
  const unauthRes = await fetch(`${API_BASE}/api/admin/sessions/status`);
  if (unauthRes.status !== 401) throw new Error(`Expected 401, got ${unauthRes.status}`);
  console.log('✔ Unauthenticated request correctly rejected with 401');

  // 2. Non-admin check
  console.log('\n▶ [2/4] Checking non-admin access (role: user)...');
  const userSession = await loginAccount(userAccount);
  const forbiddenRes = await fetch(`${API_BASE}/api/admin/sessions/status`, {
    headers: { Authorization: `Bearer ${userSession.token}` },
  });
  if (forbiddenRes.status !== 403) throw new Error(`Expected 403, got ${forbiddenRes.status}`);
  console.log('✔ Non-admin correctly rejected with 403');

  // 3. Admin status inspection
  console.log('\n▶ [3/4] Admin inspecting session storage metrics & scheduler...');
  const adminSession = await loginAccount(adminAccount);
  const statusRes = await fetch(`${API_BASE}/api/admin/sessions/status`, {
    headers: { Authorization: `Bearer ${adminSession.token}` },
  });
  if (!statusRes.ok) throw new Error(`Expected 200, got ${statusRes.status}`);
  const statusBody = await statusRes.json();
  console.log(`✔ Session storage status retrieved:`);
  console.log(`  Total Active Sessions: ${statusBody.data.totalSessions}`);
  console.log(`  Total Active Nonces:   ${statusBody.data.totalNonces}`);
  console.log(`  Scheduler Active:      ${statusBody.data.schedulerActive}`);
  console.log(`  Pruning Cadence:       ${statusBody.data.pruneCadenceHours} hour(s)`);

  if (!statusBody.data.schedulerActive) {
    throw new Error('Expected sessionPruneTimer to be active on server!');
  }

  // 4. Inject an expired test session and trigger on-demand prune
  console.log('\n▶ [4/4] Injecting expired session & triggering admin prune...');
  const expiredToken = 'test-expired-token-12345';
  const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h in the past
  const sessId = `sess-${expiredToken}`;
  const mockAddr = '0x0000000000000000000000000000000000000001';
  await prisma.$executeRaw`
    INSERT INTO "Session" ("id", "token", "address", "expiresAt", "createdAt")
    VALUES (${sessId}, ${expiredToken}, ${mockAddr}, ${pastDate}, CURRENT_TIMESTAMP);
  `;

  const pruneRes = await fetch(`${API_BASE}/api/admin/sessions/prune`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminSession.token}` },
  });
  if (!pruneRes.ok) throw new Error(`Prune request failed: ${pruneRes.status}`);
  const pruneBody = await pruneRes.json();
  console.log(`✔ Prune executed successfully:`);
  console.log(`  Pruned Sessions: ${pruneBody.data.prunedSessions}`);
  console.log(`  Pruned Nonces:   ${pruneBody.data.prunedNonces}`);

  if (pruneBody.data.prunedSessions < 1) {
    throw new Error('Expected at least 1 expired session to be pruned');
  }

  // Verify expired token is gone
  const checkExpired = await prisma.$queryRaw`SELECT * FROM "Session" WHERE "token" = ${expiredToken};`;
  if (checkExpired.length !== 0) throw new Error('Expired session was not deleted from table!');
  console.log('✔ Expired session row verified deleted from database.');

  console.log('\n====================================================');
  console.log(' ✔ ALL SESSION PRUNING & MAINTENANCE TESTS PASSED!  ');
  console.log('====================================================\n');
}

main()
  .catch((err) => {
    console.error('Test failed:', err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
