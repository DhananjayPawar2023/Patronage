import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-env.mjs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const apiUrl = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';
const deployment = JSON.parse(fs.readFileSync(path.resolve('contracts/deployments/31337.json'), 'utf8'));
const artworkArtifact = JSON.parse(fs.readFileSync(path.resolve('contracts/artifacts/ArtworkNFT.json'), 'utf8'));
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const accounts = [
  privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
  privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'),
];
const wallets = accounts.map((account) => createWalletClient({ account, chain: foundry, transport: http(rpcUrl) }));
const auction = deployment.contracts.AuctionHouse;
const factory = deployment.contracts.ArtistFactory;

async function tx(wallet, request) {
  const hash = await wallet.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function waitForIndexedLot(predicate = () => true) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${apiUrl}/api/lots`);
    if (response.ok) {
      const body = await response.json();
      if (body.data?.some(predicate)) return body.data.find(predicate);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Indexer did not expose the created lot within 10 seconds.');
}

const nonceResponse = await fetch(`${apiUrl}/api/siwe/nonce`);
const { nonce } = await nonceResponse.json();
const siweMessage = `${new URL(apiUrl).host} wants you to sign in with your Ethereum account:\n${accounts[0].address}\n\nSign in to Patronage local development.\n\nURI: ${apiUrl}\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
const siweSignature = await accounts[0].signMessage({ message: siweMessage });
const authResponse = await fetch(`${apiUrl}/api/siwe/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: accounts[0].address, message: siweMessage, signature: siweSignature, nonce }) });
if (!authResponse.ok) throw new Error(`SIWE login failed with HTTP ${authResponse.status}.`);
const authBody = await authResponse.json();
const authorization = `Bearer ${authBody.session.token}`;

const uploadResponse = await fetch(`${apiUrl}/api/upload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization },
  body: JSON.stringify({
    title: 'Local vertical slice artwork',
    description: 'Created by the executable local acceptance test.',
    filename: 'vertical-slice.png',
    imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEeQHzH4dYfgAAAABJRU5ErkJggg==',
    artistName: 'Local test artist',
    artistHandle: 'local-test-artist',
  }),
});
if (!uploadResponse.ok) throw new Error(`Upload failed with HTTP ${uploadResponse.status}.`);
const uploadBody = await uploadResponse.json();
const metadataUri = uploadBody.data?.metadataUri;
if (!metadataUri) throw new Error('Upload did not return metadataUri.');

const collection = await publicClient.readContract({
  address: factory.address,
  abi: factory.abi,
  functionName: 'collectionOf',
  args: [accounts[0].address],
});
let collectionAddress = collection;
if (collectionAddress === '0x0000000000000000000000000000000000000000') {
  await tx(wallets[0], {
    address: factory.address,
    abi: factory.abi,
    functionName: 'createCollection',
    args: ['Local Test Collection', 'LTEST'],
  });
  collectionAddress = await publicClient.readContract({
    address: factory.address,
    abi: factory.abi,
    functionName: 'collectionOf',
    args: [accounts[0].address],
  });
}

const tokenIdToMint = await publicClient.readContract({
  address: collectionAddress,
  abi: artworkArtifact.abi,
  functionName: 'nextTokenId',
});

await tx(wallets[0], {
  address: collectionAddress,
  abi: artworkArtifact.abi,
  functionName: 'mint',
  args: [metadataUri],
});
await tx(wallets[0], {
  address: collectionAddress,
  abi: artworkArtifact.abi,
  functionName: 'approve',
  args: [auction.address, tokenIdToMint],
});

const block = await publicClient.getBlock();
const start = block.timestamp;
const end = start + 600n;
const lotId = await publicClient.readContract({ address: auction.address, abi: auction.abi, functionName: 'nextLotId' });
await tx(wallets[0], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'createLot',
  args: [collectionAddress, tokenIdToMint, parseEther('0.1'), parseEther('0.01'), start, end],
});

const initialRefund = await publicClient.readContract({
  address: auction.address,
  abi: auction.abi,
  functionName: 'refundable',
  args: [accounts[1].address],
});

const lot = await waitForIndexedLot((candidate) => candidate.lotId === lotId.toString());
await tx(wallets[1], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'placeBid',
  args: [BigInt(lot.lotId)],
  value: parseEther('0.1'),
});
await tx(wallets[2], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'placeBid',
  args: [BigInt(lot.lotId)],
  value: parseEther('0.2'),
});

const refund = await publicClient.readContract({
  address: auction.address,
  abi: auction.abi,
  functionName: 'refundable',
  args: [accounts[1].address],
});
if (refund - initialRefund !== parseEther('0.1')) throw new Error(`Expected +0.1 ETH refund delta, got ${formatEther(refund - initialRefund)} ETH.`);

// Step 16: First collector executes actual refund withdrawal
await tx(wallets[1], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'withdrawRefund',
  args: [],
});
const remainingRefund = await publicClient.readContract({
  address: auction.address,
  abi: auction.abi,
  functionName: 'refundable',
  args: [accounts[1].address],
});
if (remainingRefund !== 0n) throw new Error('Expected 0 remaining refundable after withdrawal.');
console.log('✔ Collector 1 successfully withdrew outbid refund from escrow.');

const mintPrice = await publicClient.readContract({
  address: deployment.contracts.PatronEdition.address,
  abi: deployment.contracts.PatronEdition.abi,
  functionName: 'mintPrice',
});
await tx(wallets[1], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'mintPatronEdition',
  args: [BigInt(lot.lotId)],
  value: mintPrice,
});
console.log('✔ Collector 1 minted Patron Edition.');

// Track fee distribution
const treasuryAddress = deployment.contracts.Treasury.address;
const preTreasuryBal = await publicClient.getBalance({ address: treasuryAddress });

await publicClient.request({ method: 'evm_increaseTime', params: [700] });
await publicClient.request({ method: 'evm_mine', params: [] });
await tx(wallets[0], {
  address: auction.address,
  abi: auction.abi,
  functionName: 'settle',
  args: [BigInt(lot.lotId)],
});

const postTreasuryBal = await publicClient.getBalance({ address: treasuryAddress });
const treasuryDelta = postTreasuryBal - preTreasuryBal;
if (treasuryDelta <= 0n) throw new Error('Expected positive protocol fee distribution to Treasury.');
console.log(`✔ Auction settled with protocol fee distributed to Treasury: +${formatEther(treasuryDelta)} ETH`);

const owner = await publicClient.readContract({
  address: collectionAddress,
  abi: artworkArtifact.abi,
  functionName: 'ownerOf',
  args: [1n],
});
if (owner.toLowerCase() !== accounts[2].address.toLowerCase()) throw new Error(`NFT owner mismatch: ${owner}`);

const indexed = await waitForIndexedLot((candidate) => candidate.lotId === lot.lotId && candidate.status === 'settled');
if (indexed.status !== 'settled') throw new Error(`Indexer status is ${indexed.status}, expected settled.`);

console.log(JSON.stringify({
  upload: 'verified',
  collectionAddress,
  lotId: lot.lotId,
  refundEth: formatEther(refund),
  patronMint: 'verified',
  nftOwner: owner,
  indexedStatus: indexed.status,
}, null, 2));
