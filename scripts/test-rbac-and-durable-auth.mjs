import '../src/config/load-env.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const API_BASE = 'http://127.0.0.1:8787';

// Account 0 is configured as default Admin: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
// Account 1 is normal user / non-admin: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
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

  if (!verifyRes.ok) {
    const err = await verifyRes.json();
    throw new Error(`Login failed for ${account.address}: ${JSON.stringify(err)}`);
  }
  const data = await verifyRes.json();
  return { token: data.session.token, role: data.role };
}

async function main() {
  console.log('=== TESTING RBAC AUTHORIZATION & DURABLE SIWE SESSIONS ===\n');

  // 1. Unauthenticated access check
  console.log('▶ [1/5] Testing unauthenticated access to /api/admin/artists...');
  const unauthRes = await fetch(`${API_BASE}/api/admin/artists`);
  if (unauthRes.status !== 401) throw new Error(`Expected 401 for unauth admin route, got ${unauthRes.status}`);
  const unauthBody = await unauthRes.json();
  console.log(`✔ Correctly rejected with 401:`, unauthBody.error);

  // 2. Normal user login and unauthorized RBAC check
  console.log('\n▶ [2/5] Logging in as non-admin user (Collector Alice)...');
  const userSession = await loginAccount(userAccount);
  console.log(`✔ User logged in with role: '${userSession.role}'`);

  const forbiddenAdminRes = await fetch(`${API_BASE}/api/admin/artists`, {
    headers: { Authorization: `Bearer ${userSession.token}` },
  });
  if (forbiddenAdminRes.status !== 403) throw new Error(`Expected 403 for non-admin on admin route, got ${forbiddenAdminRes.status}`);
  const forbiddenBody = await forbiddenAdminRes.json();
  console.log(`✔ Non-admin correctly rejected with 403:`, forbiddenBody.error);

  const forbiddenDelistRes = await fetch(`${API_BASE}/api/moderation/delist`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userSession.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ contractAddress: '0x1234567890123456789012345678901234567890', tokenId: 1 }),
  });
  if (forbiddenDelistRes.status !== 403) throw new Error(`Expected 403 for non-moderator on delist, got ${forbiddenDelistRes.status}`);
  console.log(`✔ Non-moderator delisting rejected with 403`);

  // 3. Admin user login and authorized RBAC check
  console.log('\n▶ [3/5] Logging in as Admin (Deployer / Artist)...');
  const adminSession = await loginAccount(adminAccount);
  console.log(`✔ Admin logged in with role: '${adminSession.role}'`);

  const adminArtistsRes = await fetch(`${API_BASE}/api/admin/artists`, {
    headers: { Authorization: `Bearer ${adminSession.token}` },
  });
  if (adminArtistsRes.status !== 200) throw new Error(`Expected 200 for admin on admin route, got ${adminArtistsRes.status}`);
  const adminArtistsData = await adminArtistsRes.json();
  console.log(`✔ Admin granted 200 access: Retrieved ${adminArtistsData.data.length} artist application(s)`);

  // 4. Request validation & structured errors
  console.log('\n▶ [4/5] Testing structured request validation on moderation delist...');
  const badDelistRes = await fetch(`${API_BASE}/api/moderation/delist`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminSession.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ contractAddress: 'invalid-address-format', tokenId: 1 }),
  });
  if (badDelistRes.status !== 400) throw new Error(`Expected 400 for bad address format, got ${badDelistRes.status}`);
  const badDelistData = await badDelistRes.json();
  console.log(`✔ Invalid address rejected with 400 structured error:`, badDelistData.error);

  // 5. Durable session verification (persisted in DB)
  console.log('\n▶ [5/5] Verifying session persistence in database...');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const token = adminSession.token;
  const dbSession = await prisma.$queryRaw`
    SELECT "token", "address", "expiresAt" FROM "Session" WHERE "token" = ${token} LIMIT 1;
  `;
  if (!dbSession || dbSession.length === 0) {
    throw new Error('Session token was not persisted to the Session database table');
  }
  console.log(`✔ Found durable session in Prisma SQLite table for ${dbSession[0].address}`);
  await prisma.$disconnect();

  console.log('\n================================================================');
  console.log(' SUCCESS: ALL RBAC & DURABLE AUTH VERIFICATIONS PASSED!');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('RBAC Test Failed:', err);
  process.exit(1);
});
