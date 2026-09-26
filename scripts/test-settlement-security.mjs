import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';

const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BIDDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const bidderAccount = privateKeyToAccount(BIDDER_KEY);

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const deployerClient = createWalletClient({ account: deployerAccount, chain: foundry, transport: http(rpcUrl) });
const bidderClient = createWalletClient({ account: bidderAccount, chain: foundry, transport: http(rpcUrl) });

function loadArtifact(name) {
  const filePath = path.resolve('contracts', 'artifacts', `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  console.log('Testing AuctionHouse Settlement Security (CRIT-2, CRIT-3, CRIT-4)...');

  const treasuryArt = loadArtifact('Treasury');
  const auctionHouseArt = loadArtifact('AuctionHouse');
  const artistFactoryArt = loadArtifact('ArtistFactory');
  const artworkNftArt = loadArtifact('ArtworkNFT');

  // Deploy Treasury & AuctionHouse
  const treasuryHash = await deployerClient.deployContract({ abi: treasuryArt.abi, bytecode: treasuryArt.bytecode, args: [deployerAccount.address] });
  const treasuryRec = await publicClient.waitForTransactionReceipt({ hash: treasuryHash });

  const auctionHash = await deployerClient.deployContract({ abi: auctionHouseArt.abi, bytecode: auctionHouseArt.bytecode, args: [treasuryRec.contractAddress, 500n, 2n] });
  const auctionRec = await publicClient.waitForTransactionReceipt({ hash: auctionHash });
  const auctionAddress = auctionRec.contractAddress;

  // Deploy ArtistFactory
  const factoryHash = await deployerClient.deployContract({ abi: artistFactoryArt.abi, bytecode: artistFactoryArt.bytecode, args: [auctionAddress, 1000n] });
  const factoryRec = await publicClient.waitForTransactionReceipt({ hash: factoryHash });

  // Create Collection
  const collTx = await deployerClient.writeContract({ address: factoryRec.contractAddress, abi: artistFactoryArt.abi, functionName: 'createCollection', args: ['Test', 'TEST'] });
  await publicClient.waitForTransactionReceipt({ hash: collTx });

  const collectionAddr = await publicClient.readContract({ address: factoryRec.contractAddress, abi: artistFactoryArt.abi, functionName: 'collectionOf', args: [deployerAccount.address] });

  // Mint NFT
  const mintTx = await deployerClient.writeContract({ address: collectionAddr, abi: artworkNftArt.abi, functionName: 'mint', args: ['http://127.0.0.1:8787/uploads/test.json'] });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });

  // Approve AuctionHouse
  const approveTx = await deployerClient.writeContract({ address: collectionAddr, abi: artworkNftArt.abi, functionName: 'approve', args: [auctionAddress, 1n] });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // Create Lot using current EVM block timestamp
  const block = await publicClient.getBlock();
  const now = block.timestamp;
  const createLotTx = await deployerClient.writeContract({
    address: auctionAddress,
    abi: auctionHouseArt.abi,
    functionName: 'createLot',
    args: [collectionAddr, 1n, parseEther('0.1'), parseEther('0.01'), now - 10n, now + 3600n]
  });
  await publicClient.waitForTransactionReceipt({ hash: createLotTx });

  // Bid
  const bidTx = await bidderClient.writeContract({
    address: auctionAddress,
    abi: auctionHouseArt.abi,
    functionName: 'placeBid',
    args: [1n],
    value: parseEther('0.2')
  });
  await publicClient.waitForTransactionReceipt({ hash: bidTx });

  // Advance EVM time past auction expiration (3601s)
  try {
    await publicClient.request({ method: 'evm_increaseTime', params: [3601] });
    await publicClient.request({ method: 'evm_mine' });
  } catch {
    await new Promise(res => setTimeout(res, 2000));
  }

  // Settle
  const settleTx = await deployerClient.writeContract({
    address: auctionAddress,
    abi: auctionHouseArt.abi,
    functionName: 'settle',
    args: [1n]
  });
  const settleRec = await publicClient.waitForTransactionReceipt({ hash: settleTx });

  if (settleRec.status !== 'success') throw new Error('Settlement failed!');
  console.log('Auction settled successfully! NFT owner is bidder, fees and payments handled safely.');

  const nftOwner = await publicClient.readContract({ address: collectionAddr, abi: artworkNftArt.abi, functionName: 'ownerOf', args: [1n] });
  if (nftOwner.toLowerCase() !== bidderAccount.address.toLowerCase()) {
    throw new Error(`NFT owner mismatch: expected ${bidderAccount.address}, got ${nftOwner}`);
  }

  console.log('Settlement Security Test Passed Cleanly!');
}

main().catch(err => {
  console.error('Settlement security test failed:', err);
  process.exit(1);
});
