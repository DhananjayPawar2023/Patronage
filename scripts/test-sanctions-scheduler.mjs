import '../src/config/load-env.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const API_BASE = 'http://127.0.0.1:8787';

// Account 0 is configured Admin: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
// Account 1 is normal non-admin User: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
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
  console.log('====================================================');
  console.log('    TESTING SANCTIONS SCHEDULER & ADMIN ENDPOINTS   ');
  console.log('====================================================\n');

  // 1. Unauthenticated checks
  console.log('▶ [1/4] Checking unauthenticated access to /api/admin/sanctions/status...');
  const unauthRes = await fetch(`${API_BASE}/api/admin/sanctions/status`);
  if (unauthRes.status !== 401) {
    throw new Error(`Expected 401, got ${unauthRes.status}`);
  }
  console.log('✔ Unauthenticated request correctly rejected with 401');

  // 2. Non-admin user checks (RBAC)
  console.log('\n▶ [2/4] Checking non-admin access (role: user)...');
  const userSession = await loginAccount(userAccount);
  const forbiddenRes = await fetch(`${API_BASE}/api/admin/sanctions/status`, {
    headers: { Authorization: `Bearer ${userSession.token}` },
  });
  if (forbiddenRes.status !== 403) {
    throw new Error(`Expected 403 for non-admin, got ${forbiddenRes.status}`);
  }
  console.log('✔ Non-admin correctly rejected with 403 FORBIDDEN');

  // 3. Admin status check
  console.log('\n▶ [3/4] Checking admin access to /api/admin/sanctions/status...');
  const adminSession = await loginAccount(adminAccount);
  const statusRes = await fetch(`${API_BASE}/api/admin/sanctions/status`, {
    headers: { Authorization: `Bearer ${adminSession.token}` },
  });
  if (!statusRes.ok) {
    throw new Error(`Expected 200, got ${statusRes.status}: ${await statusRes.text()}`);
  }
  const statusBody = await statusRes.json();
  console.log('✔ Sanctions status retrieved successfully:');
  console.log(`  Source: ${statusBody.data.source}`);
  console.log(`  Source Type: ${statusBody.data.sourceType}`);
  console.log(`  Regulatory Status: ${statusBody.data.regulatoryStatus}`);
  console.log(`  Legal Note: ${statusBody.data.legalNote}`);
  console.log(`  Total Blocked Addresses: ${statusBody.data.totalCount}`);
  console.log(`  Scheduler Active: ${statusBody.data.schedulerActive}`);
  console.log(`  Sync Cadence: ${statusBody.data.syncCadenceHours} hours`);

  if (!statusBody.data.schedulerActive) {
    throw new Error('Scheduler was expected to be active on server!');
  }
  if (!statusBody.data.isLiveFeedConnected) {
    throw new Error('Expected isLiveFeedConnected to be true');
  }

  // 4. Admin manual on-demand sync
  console.log('\n▶ [4/4] Triggering admin on-demand sync via POST /api/admin/sanctions/sync...');
  const syncRes = await fetch(`${API_BASE}/api/admin/sanctions/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminSession.token}` },
  });
  if (!syncRes.ok) {
    throw new Error(`Expected 200 from sync, got ${syncRes.status}: ${await syncRes.text()}`);
  }
  const syncBody = await syncRes.json();
  console.log('✔ Manual sync completed successfully:');
  console.log(`  Success: ${syncBody.success}`);
  console.log(`  Count Synced: ${syncBody.data.count}`);
  console.log(`  Metadata:`, syncBody.data.metadata);

  console.log('\n====================================================');
  console.log(' ✔ ALL SANCTIONS SCHEDULER & RBAC TESTS PASSED!');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message || err);
  process.exit(1);
});
