import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const ARTIST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const artistAccount = privateKeyToAccount(ARTIST_KEY);
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const artistClient = createWalletClient({ account: artistAccount, chain: foundry, transport: http(rpcUrl) });

function loadArtifact(name) {
  const filePath = path.resolve('contracts', 'artifacts', `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  console.log('Testing ArtistFactory and ArtworkNFT initialization (HIGH-1 & MED-1)...');

  const artistFactoryArt = loadArtifact('ArtistFactory');
  const artworkNftArt = loadArtifact('ArtworkNFT');

  // Deploy ArtistFactory with 5% royalty (500 bps)
  const factoryHash = await artistClient.deployContract({
    abi: artistFactoryArt.abi,
    bytecode: artistFactoryArt.bytecode,
    args: [artistAccount.address, 500n],
  });
  const factoryRec = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
  const factoryAddress = factoryRec.contractAddress;

  // Create Collection
  const collectionName = 'Artist Masterpieces';
  const collectionSymbol = 'ARTIST';
  const createTx = await artistClient.writeContract({
    address: factoryAddress,
    abi: artistFactoryArt.abi,
    functionName: 'createCollection',
    args: [collectionName, collectionSymbol],
  });
  await publicClient.waitForTransactionReceipt({ hash: createTx });

  const collectionAddress = await publicClient.readContract({
    address: factoryAddress,
    abi: artistFactoryArt.abi,
    functionName: 'collectionOf',
    args: [artistAccount.address],
  });
  console.log(`Deployed collection at ${collectionAddress}`);

  // Test name & symbol
  const name = await publicClient.readContract({
    address: collectionAddress,
    abi: artworkNftArt.abi,
    functionName: 'name',
  });
  const symbol = await publicClient.readContract({
    address: collectionAddress,
    abi: artworkNftArt.abi,
    functionName: 'symbol',
  });

  if (name !== collectionName) throw new Error(`Name mismatch: expected '${collectionName}', got '${name}'`);
  if (symbol !== collectionSymbol) throw new Error(`Symbol mismatch: expected '${collectionSymbol}', got '${symbol}'`);
  console.log(`Collection name ('${name}') and symbol ('${symbol}') verified!`);

  // Test EIP-2981 Royalty Receiver
  const salePrice = parseEther('1.0');
  const [receiver, royaltyAmount] = await publicClient.readContract({
    address: collectionAddress,
    abi: artworkNftArt.abi,
    functionName: 'royaltyInfo',
    args: [1n, salePrice],
  });

  if (receiver.toLowerCase() !== artistAccount.address.toLowerCase()) {
    throw new Error(`Royalty receiver mismatch: expected artist '${artistAccount.address}', got '${receiver}'`);
  }
  if (royaltyAmount !== parseEther('0.05')) {
    throw new Error(`Royalty amount mismatch: expected 0.05 ETH, got ${royaltyAmount}`);
  }
  console.log(`Royalty receiver (${receiver}) correctly set to artist address!`);

  // Verify Artist can create a SECOND collection without restriction
  const createSecondTx = await artistClient.writeContract({
    address: factoryAddress,
    abi: artistFactoryArt.abi,
    functionName: 'createCollection',
    args: ['Second Collection', 'ART2'],
  });
  await publicClient.waitForTransactionReceipt({ hash: createSecondTx });
  console.log('✔ Second collection created successfully without restriction!');

  // Verify sequential token minting on collection
  const mint1Tx = await artistClient.writeContract({
    address: collectionAddress,
    abi: artworkNftArt.abi,
    functionName: 'mint',
    args: ['ipfs://artwork1.json'],
  });
  const mint1Rec = await publicClient.waitForTransactionReceipt({ hash: mint1Tx });
  console.log('mint1 status:', mint1Rec.status);

  const mint2Tx = await artistClient.writeContract({
    address: collectionAddress,
    abi: artworkNftArt.abi,
    functionName: 'mint',
    args: ['ipfs://artwork2.json'],
  });
  const mint2Rec = await publicClient.waitForTransactionReceipt({ hash: mint2Tx });
  console.log('mint2 status:', mint2Rec.status);

  const owner1 = await publicClient.readContract({ address: collectionAddress, abi: artworkNftArt.abi, functionName: 'ownerOf', args: [1n] });
  console.log('owner1:', owner1);
  const owner2 = await publicClient.readContract({ address: collectionAddress, abi: artworkNftArt.abi, functionName: 'ownerOf', args: [2n] });
  console.log('owner2:', owner2);
  if (owner1.toLowerCase() !== artistAccount.address.toLowerCase() || owner2.toLowerCase() !== artistAccount.address.toLowerCase()) {
    throw new Error('Owner mismatch for multi-minted tokens');
  }
  console.log('✔ Sequential token minting (#1, #2) verified successfully!');

  console.log('HIGH-1 & MED-1 Tests Passed Cleanly!');
}

main().catch(err => {
  console.error('ArtistFactory test failed:', err);
  process.exit(1);
});
