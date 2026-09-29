import '../src/config/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { privateKeyToAccount } from 'viem/accounts';

const prisma = new PrismaClient();
const base = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8788';
const artistAccount = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const viewerAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

async function signIn(account) {
  const nonceResponse = await fetch(`${base}/api/siwe/nonce`);
  if (!nonceResponse.ok) throw new Error(`Nonce request failed: ${nonceResponse.status}`);
  const { nonce } = await nonceResponse.json();
  const origin = new URL(base).origin;
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${account.address}\n\nArtist profile integration test.\n\nURI: ${origin}\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = await account.signMessage({ message });
  const response = await fetch(`${base}/api/siwe/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: account.address, message, signature, nonce }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`SIWE verification failed: ${response.status} ${JSON.stringify(result)}`);
  return result.session.token;
}

async function expectStatus(label, response, status) {
  if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status}: ${await response.text()}`);
  console.log(`✔ ${label}: HTTP ${status}`);
}

let testArtist = null;
let artistToken;
let viewerToken;
let testNotificationId;
try {
  artistToken = await signIn(artistAccount);
  viewerToken = await signIn(viewerAccount);
  const handle = `qa_${Date.now().toString(36)}`;
  await expectStatus('unauthenticated profile edit rejected', await fetch(`${base}/api/artists/profile`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Unauthorized' }),
  }), 401);
  await expectStatus('unauthenticated follow rejected', await fetch(`${base}/api/artists/${handle}/follow`, { method: 'POST' }), 401);

  const apply = await fetch(`${base}/api/artists/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${artistToken}` },
    body: JSON.stringify({ handle, displayName: 'Temporary profile acceptance test', bio: 'Temporary test record.' }),
  });
  if (!apply.ok) throw new Error(`Artist application failed: ${apply.status} ${await apply.text()}`);
  testArtist = (await apply.json()).data;
  const approve = await fetch(`${base}/api/admin/artists/${artistAccount.address}/approve`, {
    method: 'POST', headers: { authorization: `Bearer ${viewerToken}` },
  });
  if (!approve.ok) throw new Error(`Test artist approval failed: ${approve.status} ${await approve.text()}`);
  console.log('✔ authenticated artist application and admin approval');

  const edit = await fetch(`${base}/api/artists/profile`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${artistToken}` },
    body: JSON.stringify({ displayName: 'Updated acceptance profile', bio: 'Persisted profile biography.', websiteUrl: 'https://example.org/artist' }),
  });
  if (!edit.ok) throw new Error(`Profile edit failed: ${edit.status} ${await edit.text()}`);
  const byHandle = await fetch(`${base}/api/artists/by-handle/${handle}`);
  const publicArtist = await byHandle.json();
  if (!byHandle.ok || publicArtist.data?.bio !== 'Persisted profile biography.' || publicArtist.data?.websiteUrl !== 'https://example.org/artist') {
    throw new Error('Public profile did not return persisted artist profile fields.');
  }
  console.log('✔ public artist profile resolves by handle with persisted fields');

  const selfFollow = await fetch(`${base}/api/artists/${handle}/follow`, { method: 'POST', headers: { authorization: `Bearer ${artistToken}` } });
  await expectStatus('self-follow rejected', selfFollow, 400);
  const follow = () => fetch(`${base}/api/artists/${handle}/follow`, { method: 'POST', headers: { authorization: `Bearer ${viewerToken}` } });
  const followed = await follow();
  if (!followed.ok) throw new Error(`Follow failed: ${followed.status} ${await followed.text()}`);
  const followedAgain = await follow();
  if (!followedAgain.ok || (await followedAgain.json()).data.followerCount !== 1) throw new Error('Follow operation is not idempotent.');
  console.log('✔ SIWE follow persists and duplicate follow is idempotent');

  testNotificationId = `profile-privacy-${Date.now()}`;
  await prisma.notification.create({ data: { id: testNotificationId, wallet: viewerAccount.address.toLowerCase(), type: 'test', payload: '{}' } });
  const privateResponse = await fetch(`${base}/api/profile/${viewerAccount.address}`);
  const privateBody = await privateResponse.json();
  if (privateBody.data?.recentNotifications?.length) throw new Error('Unauthenticated profile response leaked notifications.');
  const ownResponse = await fetch(`${base}/api/profile/${viewerAccount.address}`, { headers: { authorization: `Bearer ${viewerToken}` } });
  const ownBody = await ownResponse.json();
  if (!ownBody.data?.recentNotifications?.some((item) => item.id === testNotificationId)) throw new Error('Authenticated owner could not read own notification.');
  console.log('✔ profile notifications are private to the authenticated wallet');

  const unfollow = await fetch(`${base}/api/artists/${handle}/follow`, { method: 'DELETE', headers: { authorization: `Bearer ${viewerToken}` } });
  if (!unfollow.ok || (await unfollow.json()).data.followerCount !== 0) throw new Error('Unfollow did not persist.');
  console.log('✔ unfollow persists and follower count returns to zero');
  const badUrl = await fetch(`${base}/api/artists/profile`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${artistToken}` },
    body: JSON.stringify({ displayName: 'Updated acceptance profile', websiteUrl: 'javascript:alert(1)' }),
  });
  await expectStatus('unsafe profile URL rejected', badUrl, 400);
  console.log('Artist profile runtime acceptance passed.');
} finally {
  if (testArtist) {
    await prisma.artistFollow.deleteMany({ where: { artistId: testArtist.id } });
    await prisma.artist.delete({ where: { id: testArtist.id } }).catch(() => {});
  }
  if (testNotificationId) await prisma.notification.deleteMany({ where: { id: testNotificationId } });
  await prisma.$disconnect();
}
