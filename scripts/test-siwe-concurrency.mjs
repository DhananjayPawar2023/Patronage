import { PrismaClient } from '@prisma/client';
import { generateNonce, consumeNonce, createSiweMessage, validateSiweMessage } from '../src/auth/siwe.mjs';

const prisma = new PrismaClient();

async function runConcurrencyTest() {
  console.log('================================================================');
  console.log('   P0 SIWE NONCE CONCURRENCY & VALIDATION SECURITY TEST SUITE   ');
  console.log('================================================================\n');

  // Test 1: 10 Simultaneous Attempts on a Single Nonce
  console.log('▶ [1/4] Testing 10 simultaneous consumeNonce attempts on 1 nonce...');
  const nonce = await generateNonce();

  // Launch 10 simultaneous attempts
  const attempts = 10;
  const promises = Array.from({ length: attempts }, (_, i) => consumeNonce(nonce));
  const results = await Promise.all(promises);

  const accepted = results.filter((r) => r === true).length;
  const rejected = results.filter((r) => r === false).length;

  console.log(`Results: ${accepted} accepted, ${rejected} rejected.`);

  if (accepted !== 1 || rejected !== 9) {
    throw new Error(`CONCURRENCY VIOLATION! Expected exactly 1 accepted and 9 rejected, got ${accepted} accepted and ${rejected} rejected.`);
  }
  console.log('✔ Nonce atomicity verified: Exactly 1 accepted, 9 rejected.\n');

  // Test 2: Double-consumption / Replay Attempt
  console.log('▶ [2/4] Testing sequential re-consumption / replay attack...');
  const replayAttempt = await consumeNonce(nonce);
  if (replayAttempt !== false) {
    throw new Error('REPLAY VULNERABILITY! Consumed nonce was accepted again.');
  }
  console.log('✔ Replay rejected: Previously consumed nonce cannot be reused.\n');

  // Test 3: Expired Nonce Rejection
  console.log('▶ [3/4] Testing expired nonce consumption...');
  const expiredNonce = 'test-expired-nonce-' + Math.random().toString(36).substring(2);
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  await prisma.$executeRaw`
    INSERT INTO "SiweNonce" ("id", "nonce", "expiresAt", "createdAt")
    VALUES (${'exp-' + expiredNonce}, ${expiredNonce}, ${pastIso}, CURRENT_TIMESTAMP);
  `;
  const expiredResult = await consumeNonce(expiredNonce);
  if (expiredResult !== false) {
    throw new Error('SECURITY VIOLATION! Expired nonce was accepted.');
  }
  console.log('✔ Expired nonce rejected successfully.\n');

  // Test 4: Hardened SIWE Message Validation Suite
  console.log('▶ [4/4] Testing hardened SIWE message parser and verifier...');

  const validAddress = '0x1111111111111111111111111111111111111111';
  const validDomain = 'patronage.art';
  const validUri = 'https://patronage.art';
  const testNonce = 'nonce12345';
  const now = new Date();

  // Valid Base Message
  const validMsg = createSiweMessage({
    domain: validDomain,
    address: validAddress,
    uri: validUri,
    chainId: 31337,
    nonce: testNonce,
    issuedAt: now.toISOString(),
  });

  const validRes = validateSiweMessage(validMsg, {
    expectedAddress: validAddress,
    expectedNonce: testNonce,
    expectedChainId: 31337,
    expectedUri: validUri,
    allowedDomains: [validDomain],
  });
  if (!validRes.valid) throw new Error(`Valid message failed: ${validRes.reason}`);
  console.log('  ✔ Valid SIWE message accepted');

  // Reject Wrong Domain
  const wrongDomainRes = validateSiweMessage(validMsg, {
    expectedAddress: validAddress,
    expectedNonce: testNonce,
    expectedChainId: 31337,
    allowedDomains: ['evil-phishing.com'],
  });
  if (wrongDomainRes.valid) throw new Error('Failed to reject unauthorized domain');
  console.log('  ✔ Wrong domain rejected:', wrongDomainRes.reason);

  // Reject Wrong Chain ID
  const wrongChainRes = validateSiweMessage(validMsg, {
    expectedAddress: validAddress,
    expectedNonce: testNonce,
    expectedChainId: 1, // Mainnet expected, got 31337
  });
  if (wrongChainRes.valid) throw new Error('Failed to reject chain mismatch');
  console.log('  ✔ Wrong chain ID rejected:', wrongChainRes.reason);

  // Reject Wrong Signer Address
  const wrongAddrRes = validateSiweMessage(validMsg, {
    expectedAddress: '0x2222222222222222222222222222222222222222',
    expectedNonce: testNonce,
  });
  if (wrongAddrRes.valid) throw new Error('Failed to reject address mismatch');
  console.log('  ✔ Wrong address rejected:', wrongAddrRes.reason);

  // Reject Excessively Future-Dated Issued At
  const futureMsg = createSiweMessage({
    domain: validDomain,
    address: validAddress,
    uri: validUri,
    chainId: 31337,
    nonce: testNonce,
    issuedAt: new Date(Date.now() + 5 * 60_000).toISOString(), // 5m in future
  });
  const futureRes = validateSiweMessage(futureMsg);
  if (futureRes.valid) throw new Error('Failed to reject future-dated message');
  console.log('  ✔ Future-dated message rejected:', futureRes.reason);

  // Reject Expired Message (issued > 10m ago)
  const oldMsg = createSiweMessage({
    domain: validDomain,
    address: validAddress,
    uri: validUri,
    chainId: 31337,
    nonce: testNonce,
    issuedAt: new Date(Date.now() - 15 * 60_000).toISOString(), // 15m ago
  });
  const oldRes = validateSiweMessage(oldMsg);
  if (oldRes.valid) throw new Error('Failed to reject message issued > 10m ago');
  console.log('  ✔ Stale message rejected:', oldRes.reason);

  // Reject Expired via Expiration Time
  const expMsg = createSiweMessage({
    domain: validDomain,
    address: validAddress,
    uri: validUri,
    chainId: 31337,
    nonce: testNonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
  });
  const expRes = validateSiweMessage(expMsg);
  if (expRes.valid) throw new Error('Failed to reject message expired via Expiration Time');
  console.log('  ✔ Expired message (Expiration Time) rejected:', expRes.reason);

  // Reject Not-Yet-Valid via Not Before
  const nbMsg = createSiweMessage({
    domain: validDomain,
    address: validAddress,
    uri: validUri,
    chainId: 31337,
    nonce: testNonce,
    issuedAt: now.toISOString(),
    notBefore: new Date(Date.now() + 60_000).toISOString(), // Valid in 1 minute
  });
  const nbRes = validateSiweMessage(nbMsg);
  if (nbRes.valid) throw new Error('Failed to reject not-yet-valid message (notBefore in future)');
  console.log('  ✔ Not-yet-valid message (Not Before) rejected:', nbRes.reason);

  console.log('\n================================================================');
  console.log(' ALL P0 SIWE CONCURRENCY & VALIDATION SECURITY TESTS PASSED!    ');
  console.log('================================================================\n');

  await prisma.$disconnect();
}

runConcurrencyTest().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
