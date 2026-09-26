import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-env.mjs';
import { createPublicClient, createWalletClient, http, parseEther, keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, base, baseSepolia, foundry } from 'viem/chains';

const NETWORKS = {
  'sepolia': { chain: sepolia, chainId: 11155111, defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  'mainnet': { chain: mainnet, chainId: 1, defaultRpc: 'https://eth.llamarpc.com' },
  'base-sepolia': { chain: baseSepolia, chainId: 84532, defaultRpc: 'https://sepolia.base.org' },
  'base': { chain: base, chainId: 8453, defaultRpc: 'https://mainnet.base.org' },
  'local': { chain: foundry, chainId: 31337, defaultRpc: 'http://127.0.0.1:8545' },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let networkName = process.env.NETWORK || 'local';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
      networkName = args[i + 1];
    }
  }
  return networkName.toLowerCase();
}

function loadArtifact(name) {
  const filePath = path.resolve('contracts', 'artifacts', `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact ${name}.json not found. Run 'node scripts/compile-contracts.mjs' first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  const networkKey = parseArgs();
  const networkConfig = NETWORKS[networkKey] || NETWORKS['local'];
  const chainId = Number(process.env.CHAIN_ID || networkConfig.chainId);
  const rpcUrl = process.env.RPC_URL || networkConfig.defaultRpc;
  const targetChain = networkConfig.chain;

  console.log('====================================================');
  console.log(`  PATRONAGE CONTRACT DEPLOYMENT: [${networkKey.toUpperCase()}]`);
  console.log(`  Chain ID: ${chainId} | RPC: ${rpcUrl}`);
  console.log('====================================================\n');

  let privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    if (networkKey === 'local') {
      privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil account 0 default for local sandbox
    } else {
      throw new Error(`DEPLOYER_PRIVATE_KEY environment variable is strictly required for remote deployment to ${networkKey}.`);
    }
  }
  const deployerAccount = privateKeyToAccount(privateKey);
  console.log(`Deployer Address: ${deployerAccount.address}`);

  const publicClient = createPublicClient({ chain: targetChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployerAccount, chain: targetChain, transport: http(rpcUrl) });

  const balance = await publicClient.getBalance({ address: deployerAccount.address });
  console.log(`Deployer Balance: ${(Number(balance) / 1e18).toFixed(4)} ETH\n`);
  if (balance === 0n) {
    throw new Error(`Deployer ${deployerAccount.address} has zero balance on ${networkKey}. Fund the account to deploy.`);
  }

  const treasuryArtifact = loadArtifact('Treasury');
  const auctionHouseArtifact = loadArtifact('AuctionHouse');
  const patronEditionArtifact = loadArtifact('PatronEdition');
  const artistFactoryArtifact = loadArtifact('ArtistFactory');
  const platformRegistryArtifact = loadArtifact('PlatformRegistry');
  const artworkNftArtifact = loadArtifact('ArtworkNFT');
  const timelockArtifact = loadArtifact('PatronTimelock');

  const startBlock = await publicClient.getBlockNumber();

  async function deploy(artifact, args = []) {
    console.log(`Deploying ${artifact.contractName}...`);
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
    });
    console.log(`Transaction sent: ${hash}. Awaiting confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✔ Deployed ${artifact.contractName} at ${receipt.contractAddress} (block ${receipt.blockNumber})`);
    return { address: receipt.contractAddress, receipt };
  }

  // 1. Treasury
  const treasury = await deploy(treasuryArtifact, [deployerAccount.address]);

  // 2. AuctionHouse (fee: 2.5% = 250 bps, antiSnipe: 300s)
  const feeBps = BigInt(process.env.PROTOCOL_FEE_BPS || '250');
  const antiSnipeSeconds = BigInt(process.env.ANTI_SNIPE_WINDOW_SECONDS || '300');
  const auctionHouse = await deploy(auctionHouseArtifact, [treasury.address, feeBps, antiSnipeSeconds]);

  // 3. PatronEdition
  const mintPriceEth = process.env.PATRON_EDITION_MINT_PRICE_ETH || '0.05';
  const patronBaseUri = process.env.PATRON_EDITION_BASE_URI || 'ipfs://';
  const patronEdition = await deploy(patronEditionArtifact, [
    patronBaseUri,
    deployerAccount.address,
    parseEther(mintPriceEth),
  ]);

  // 4. ArtistFactory (royalty: 5.0% = 500 bps)
  const royaltyBps = BigInt(process.env.ROYALTY_BPS || '500');
  const artistFactory = await deploy(artistFactoryArtifact, [auctionHouse.address, royaltyBps]);

  // 5. PlatformRegistry
  const platformRegistry = await deploy(platformRegistryArtifact, [deployerAccount.address]);

  // 6. PatronTimelock (48h minimum delay = 172800 seconds)
  const timelockDelay = BigInt(process.env.TIMELOCK_DELAY_SECONDS || 48 * 3600);
  
  // Safe Multi-Sig Governance Assertion:
  // On local sandbox, default to deployer EOA for automated testing.
  // On remote/mainnet, require explicitly configured Safe multi-sig addresses.
  if (networkKey !== 'local' && !process.env.TIMELOCK_PROPOSERS) {
    throw new Error(
      `[GOVERNANCE ERROR] TIMELOCK_PROPOSERS must be explicitly configured with Gnosis Safe multi-sig co-signers when deploying to ${networkKey}. Single EOA proposer is forbidden.`
    );
  }

  const proposerAddresses = (process.env.TIMELOCK_PROPOSERS || deployerAccount.address)
    .split(',')
    .map((a) => a.trim());
  const executorAddresses = (process.env.TIMELOCK_EXECUTORS || '0x0000000000000000000000000000000000000000')
    .split(',')
    .map((a) => a.trim());
  const timelockAdmin = '0x0000000000000000000000000000000000000000'; // zero address yields self-governing timelock per OZ recommendation

  console.log(`Timelock Configuration:`);
  console.log(`  Delay: ${timelockDelay} seconds (48h)`);
  console.log(`  Proposers: ${proposerAddresses.join(', ')} ${process.env.TIMELOCK_PROPOSERS ? '[SAFE-CONFIGURED]' : '[EOA-DEV-MODE: Must migrate to Safe before mainnet]'}`);
  console.log(`  Executors: ${executorAddresses.join(', ')} (open execution once 48h delay passes)\n`);

  const timelock = await deploy(timelockArtifact, [
    timelockDelay,
    proposerAddresses,
    executorAddresses,
    timelockAdmin,
  ]);

  console.log('\nConfiguring contract roles & permissions...');

  // Grant AUCTION_ROLE on PatronEdition to AuctionHouse
  const AUCTION_ROLE = keccak256(stringToBytes('AUCTION_ROLE'));
  const grantTx = await walletClient.writeContract({
    address: patronEdition.address,
    abi: patronEditionArtifact.abi,
    functionName: 'grantRole',
    args: [AUCTION_ROLE, auctionHouse.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTx });
  console.log('✔ Granted AUCTION_ROLE on PatronEdition to AuctionHouse');

  const configurePatronTx = await walletClient.writeContract({
    address: auctionHouse.address,
    abi: auctionHouseArtifact.abi,
    functionName: 'setPatronEdition',
    args: [patronEdition.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: configurePatronTx });
  console.log('✔ Connected PatronEdition to AuctionHouse');

  // Governance: Grant DEFAULT_ADMIN_ROLE on AuctionHouse to PatronTimelock
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const OPERATOR_ROLE = keccak256(stringToBytes('OPERATOR_ROLE'));

  const grantTimelockAdminTx = await walletClient.writeContract({
    address: auctionHouse.address,
    abi: auctionHouseArtifact.abi,
    functionName: 'grantRole',
    args: [DEFAULT_ADMIN_ROLE, timelock.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTimelockAdminTx });
  console.log(`✔ Granted DEFAULT_ADMIN_ROLE on AuctionHouse to PatronTimelock (${timelock.address})`);

  // Grant OPERATOR_ROLE to designated guardian (for fast-path emergency pause)
  const guardianAddress = process.env.GUARDIAN_ADDRESS || deployerAccount.address;
  if (guardianAddress.toLowerCase() !== deployerAccount.address.toLowerCase()) {
    const grantGuardianTx = await walletClient.writeContract({
      address: auctionHouse.address,
      abi: auctionHouseArtifact.abi,
      functionName: 'grantRole',
      args: [OPERATOR_ROLE, guardianAddress],
    });
    await publicClient.waitForTransactionReceipt({ hash: grantGuardianTx });
    console.log(`✔ Granted OPERATOR_ROLE on AuctionHouse to Guardian (${guardianAddress})`);
  }

  // If remote deployment, revoke deployer's direct DEFAULT_ADMIN_ROLE on AuctionHouse
  if (networkKey !== 'local' && process.env.REVOKE_DEPLOYER_ADMIN !== 'false') {
    const revokeDeployerTx = await walletClient.writeContract({
      address: auctionHouse.address,
      abi: auctionHouseArtifact.abi,
      functionName: 'revokeRole',
      args: [DEFAULT_ADMIN_ROLE, deployerAccount.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: revokeDeployerTx });
    console.log(`✔ Revoked DEFAULT_ADMIN_ROLE on AuctionHouse from Deployer EOA (${deployerAccount.address})`);
  }

  // Register components on PlatformRegistry
  const registerComponents = [
    { key: keccak256(stringToBytes('TREASURY')), addr: treasury.address },
    { key: keccak256(stringToBytes('AUCTION_HOUSE')), addr: auctionHouse.address },
    { key: keccak256(stringToBytes('PATRON_EDITION')), addr: patronEdition.address },
    { key: keccak256(stringToBytes('ARTIST_FACTORY')), addr: artistFactory.address },
    { key: keccak256(stringToBytes('TIMELOCK')), addr: timelock.address },
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
  console.log('✔ Registered components in PlatformRegistry');

  // Approve deployer as an artist in PlatformRegistry
  const approveTx = await walletClient.writeContract({
    address: platformRegistry.address,
    abi: platformRegistryArtifact.abi,
    functionName: 'setArtistApproval',
    args: [deployerAccount.address, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log('✔ Approved deployer artist in PlatformRegistry');

  const artworkImplementation = await publicClient.readContract({
    address: artistFactory.address,
    abi: artistFactoryArtifact.abi,
    functionName: 'implementation',
  });

  const deploymentData = {
    network: networkKey,
    chainId,
    rpcUrl,
    deploymentBlock: startBlock.toString(),
    deployedAt: new Date().toISOString(),
    contracts: {
      Treasury: { address: treasury.address, abi: treasuryArtifact.abi },
      AuctionHouse: { address: auctionHouse.address, abi: auctionHouseArtifact.abi },
      PatronEdition: { address: patronEdition.address, abi: patronEditionArtifact.abi },
      ArtistFactory: { address: artistFactory.address, abi: artistFactoryArtifact.abi },
      PlatformRegistry: { address: platformRegistry.address, abi: platformRegistryArtifact.abi },
      PatronTimelock: { address: timelock.address, abi: timelockArtifact.abi },
      ArtworkNFT: { address: artworkImplementation, abi: artworkNftArtifact.abi },
    },
    accounts: {
      deployer: deployerAccount.address,
    },
    governance: {
      timelockAddress: timelock.address,
      delaySeconds: Number(timelockDelay),
      proposers: proposerAddresses,
      executors: executorAddresses,
      executorPolicy: 'OpenExecutionAfterDelay (OZ standard: address(0) grants permissionless execution to any party once the 48h timelock delay has elapsed; security gating is enforced strictly by PROPOSER_ROLE)',
      isMultisigConfigured: Boolean(process.env.TIMELOCK_PROPOSERS),
      migrationPending: !process.env.TIMELOCK_PROPOSERS,
      migrationTarget: 'Gnosis Safe 3-of-5 Multi-Sig',
    },
  };

  const deploymentsDir = path.resolve('contracts', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const manifestPath = path.join(deploymentsDir, `${chainId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(deploymentData, null, 2));
  console.log(`\n✔ Deployment manifest written to ${manifestPath}`);

  // Also write 31337.json if local for backward compatibility
  if (chainId === 31337) {
    fs.writeFileSync(path.join(deploymentsDir, '31337.json'), JSON.stringify(deploymentData, null, 2));
  }

  console.log('\n====================================================');
  console.log(`🚀 DEPLOYMENT COMPLETED ON ${networkKey.toUpperCase()} (Chain ${chainId})!`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Deployment error:', err.message || err);
  process.exit(1);
});
