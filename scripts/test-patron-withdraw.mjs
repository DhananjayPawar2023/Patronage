import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';

// Anvil deterministic account #0 and #1
const DEPLOYER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // admin
const USER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // user
const TREASURY_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // treasury

const adminAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const userAccount = privateKeyToAccount(USER_PRIVATE_KEY);
const treasuryAccount = privateKeyToAccount(TREASURY_PRIVATE_KEY);

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const adminClient = createWalletClient({ account: adminAccount, chain: foundry, transport: http(rpcUrl) });
const userClient = createWalletClient({ account: userAccount, chain: foundry, transport: http(rpcUrl) });

function loadArtifact(name) {
  const filePath = path.resolve('contracts', 'artifacts', `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  console.log('Testing PatronEdition withdraw functionality...');
  const patronEditionArtifact = loadArtifact('PatronEdition');
  
  // Deploy PatronEdition
  const mintPrice = parseEther('0.1');
  const hash = await adminClient.deployContract({
    abi: patronEditionArtifact.abi,
    bytecode: patronEditionArtifact.bytecode,
    args: ['http://127.0.0.1:8787/uploads/patron-metadata.json', adminAccount.address, mintPrice],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const patronAddress = receipt.contractAddress;
  console.log(`Deployed PatronEdition at ${patronAddress}`);

  // Set lot live
  const AUCTION_ROLE = keccak256(stringToBytes('AUCTION_ROLE'));
  const grantTx = await adminClient.writeContract({
    address: patronAddress,
    abi: patronEditionArtifact.abi,
    functionName: 'grantRole',
    args: [AUCTION_ROLE, userAccount.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: grantTx });

  const setLiveTx = await adminClient.writeContract({
    account: userAccount, // using user account as AUCTION_ROLE
    address: patronAddress,
    abi: patronEditionArtifact.abi,
    functionName: 'setLotLive',
    args: [1n, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: setLiveTx });

  // Mint using user account
  const mintTx = await userClient.writeContract({
    address: patronAddress,
    abi: patronEditionArtifact.abi,
    functionName: 'mint',
    args: [1n, userAccount.address],
    value: mintPrice,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log('Successfully minted PatronEdition token');

  const contractBalance = await publicClient.getBalance({ address: patronAddress });
  if (contractBalance !== mintPrice) throw new Error(`Contract balance is ${contractBalance}, expected ${mintPrice}`);

  // Test withdraw
  const initialTreasuryBalance = await publicClient.getBalance({ address: treasuryAccount.address });
  
  const withdrawTx = await adminClient.writeContract({
    address: patronAddress,
    abi: patronEditionArtifact.abi,
    functionName: 'withdraw',
    args: [treasuryAccount.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: withdrawTx });

  const finalContractBalance = await publicClient.getBalance({ address: patronAddress });
  if (finalContractBalance !== 0n) throw new Error('Contract still has balance');

  const finalTreasuryBalance = await publicClient.getBalance({ address: treasuryAccount.address });
  if (finalTreasuryBalance !== initialTreasuryBalance + mintPrice) {
    throw new Error('Treasury did not receive the funds');
  }

  console.log('Withdraw test passed successfully!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
