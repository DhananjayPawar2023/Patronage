import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-env.mjs';
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const chainId = Number(process.env.CHAIN_ID || 31337);

// Anvil deterministic account #0
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: deployerAccount, chain: foundry, transport: http(rpcUrl) });

function loadArtifact(name) {
  const filePath = path.resolve('contracts', 'artifacts', `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact ${name}.json not found. Run 'node scripts/compile-contracts.mjs' first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function deployContract(artifact, args = []) {
  console.log(`Deploying ${artifact.contractName}...`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Deployed ${artifact.contractName} at ${receipt.contractAddress} (block ${receipt.blockNumber})`);
  return { address: receipt.contractAddress, receipt };
}

async function main() {
  console.log(`Starting local deployment on ${rpcUrl} using account ${deployerAccount.address}...`);

  const treasuryArtifact = loadArtifact('Treasury');
  const auctionHouseArtifact = loadArtifact('AuctionHouse');
  const patronEditionArtifact = loadArtifact('PatronEdition');
  const artistFactoryArtifact = loadArtifact('ArtistFactory');
  const platformRegistryArtifact = loadArtifact('PlatformRegistry');
  const artworkNftArtifact = loadArtifact('ArtworkNFT');

  const startBlock = await publicClient.getBlockNumber();

  // 1. Treasury
  const treasury = await deployContract(treasuryArtifact, [deployerAccount.address]);

  // 2. AuctionHouse (protocol fee: 2.5% = 250 bps, antiSnipe: 300s)
  const auctionHouse = await deployContract(auctionHouseArtifact, [treasury.address, 250n, 300n]);

  if (!process.env.PATRON_EDITION_MINT_PRICE_ETH) throw new Error('PATRON_EDITION_MINT_PRICE_ETH must be set in .env');
  // 3. PatronEdition
  const patronEdition = await deployContract(patronEditionArtifact, [
    process.env.PATRON_EDITION_BASE_URI || '',
    deployerAccount.address,
    parseEther(process.env.PATRON_EDITION_MINT_PRICE_ETH),
  ]);

  // 4. ArtistFactory (royalty: 5.0% = 500 bps)
  const artistFactory = await deployContract(artistFactoryArtifact, [auctionHouse.address, 500n]);

  // 5. PlatformRegistry
  const platformRegistry = await deployContract(platformRegistryArtifact, [deployerAccount.address]);

  console.log('Configuring contract roles & platform registry...');

  // Grant AUCTION_ROLE on PatronEdition to AuctionHouse
  const AUCTION_ROLE = keccak256(stringToBytes('AUCTION_ROLE'));
  const grantTx = await walletClient.writeContract({
    address: patronEdition.address,
    abi: patronEditionArtifact.abi,
    functionName: 'grantRole',
    args: [AUCTION_ROLE, auctionHouse.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTx });

  const configurePatronTx = await walletClient.writeContract({
    address: auctionHouse.address,
    abi: auctionHouseArtifact.abi,
    functionName: 'setPatronEdition',
    args: [patronEdition.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: configurePatronTx });

  // Register components on PlatformRegistry
  const registerComponents = [
    { key: keccak256(stringToBytes('TREASURY')), addr: treasury.address },
    { key: keccak256(stringToBytes('AUCTION_HOUSE')), addr: auctionHouse.address },
    { key: keccak256(stringToBytes('PATRON_EDITION')), addr: patronEdition.address },
    { key: keccak256(stringToBytes('ARTIST_FACTORY')), addr: artistFactory.address },
  ];

  for (const comp of registerComponents) {
    const tx = await walletClient.writeContract({
      address: platformRegistry.address,
      abi: platformRegistryArtifact.abi,
      functionName: 'setComponent',
      args: [comp.key, comp.addr],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }

  // Approve deployer as an artist in PlatformRegistry
  const approveTx = await walletClient.writeContract({
    address: platformRegistry.address,
    abi: platformRegistryArtifact.abi,
    functionName: 'setArtistApproval',
    args: [deployerAccount.address, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  const artworkImplementation = await publicClient.readContract({
    address: artistFactory.address,
    abi: artistFactoryArtifact.abi,
    functionName: 'implementation',
  });

  const deploymentData = {
    chainId,
    rpcUrl,
    deploymentBlock: startBlock.toString(),
    contracts: {
      Treasury: { address: treasury.address, abi: treasuryArtifact.abi },
      AuctionHouse: { address: auctionHouse.address, abi: auctionHouseArtifact.abi },
      PatronEdition: { address: patronEdition.address, abi: patronEditionArtifact.abi },
      ArtistFactory: { address: artistFactory.address, abi: artistFactoryArtifact.abi },
      PlatformRegistry: { address: platformRegistry.address, abi: platformRegistryArtifact.abi },
      ArtworkNFT: { address: artworkImplementation, abi: artworkNftArtifact.abi },
    },
    accounts: {
      deployer: deployerAccount.address,
    },
  };

  const deploymentsDir = path.resolve('contracts', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const manifestPath = path.join(deploymentsDir, '31337.json');
  fs.writeFileSync(manifestPath, JSON.stringify(deploymentData, null, 2));
  console.log(`Deployment manifest written to ${manifestPath}`);
  console.log('Local contract deployment complete!');
}

main().catch((err) => {
  console.error('Deployment error:', err.message || err);
  process.exit(1);
});
