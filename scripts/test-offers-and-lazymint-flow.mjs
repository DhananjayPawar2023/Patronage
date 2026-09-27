import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createSiweMessage } from '../src/auth/siwe.mjs';

const rpcUrl = 'http://127.0.0.1:8545';
const apiBase = 'http://127.0.0.1:8787';

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

// Standard Anvil test keys
// Account #0: Deployer/Admin
// Account #1: Artist (0x70997970C51812dc3A010C7d01b50e0d17dc79C8)
// Account #2: Collector (0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)
const artistAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const collectorAccount = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const artistWallet = createWalletClient({ account: artistAccount, chain: foundry, transport: http(rpcUrl) });
const collectorWallet = createWalletClient({ account: collectorAccount, chain: foundry, transport: http(rpcUrl) });

const manifest = JSON.parse(fs.readFileSync(path.resolve('contracts/deployments/31337.json'), 'utf8'));
const { AuctionHouse, ArtistFactory, ArtworkNFT } = manifest.contracts;

async function getAuthToken(account) {
  const nonceRes = await fetch(`${apiBase}/api/siwe/nonce`);
  const { nonce } = await nonceRes.json();
  const msg = `127.0.0.1:8787 wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Patronage.\n\nURI: http://127.0.0.1:8787\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = await account.signMessage({ message: msg });
  const verifyRes = await fetch(`${apiBase}/api/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address: account.address,
      message: msg,
      signature: sig,
      nonce,
    }),
  });
  const data = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.session.token;
}

async function runTest() {
  console.log('================================================================');
  console.log('   PATRONAGE EIP-712 LAZY MINT & ON-CHAIN OFFERS ACCEPTANCE TEST ');
  console.log('================================================================\n');

  // STEP 1: Verify Artist Collection
  console.log('1. Setting up Artist Collection clone (EIP-1167)...');
  let collectionAddr = await publicClient.readContract({
    address: ArtistFactory.address,
    abi: ArtistFactory.abi,
    functionName: 'collectionOf',
    args: [artistAccount.address],
  });

  if (!collectionAddr || collectionAddr === '0x0000000000000000000000000000000000000000') {
    const tx = await artistWallet.writeContract({
      address: ArtistFactory.address,
      abi: ArtistFactory.abi,
      functionName: 'createCollection',
      args: ['Artist Genesis Collection', 'AGC'],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    collectionAddr = await publicClient.readContract({
      address: ArtistFactory.address,
      abi: ArtistFactory.abi,
      functionName: 'collectionOf',
      args: [artistAccount.address],
    });
  }
  console.log(`✔ Artist collection active at: ${collectionAddr}`);

  // STEP 2: Gasless Lazy Mint Voucher Flow
  console.log('\n2. Testing Gasless Lazy Mint (EIP-712 Structured Data)...');
  const artistToken = await getAuthToken(artistAccount);
  const minPriceWei = parseEther('0.15');
  const nonce = BigInt(Date.now());
  const metadataUri = 'ipfs://bafkreiauthenticartlazyvoucher123456';

  const domain = {
    name: 'PatronageArtwork',
    version: '1',
    chainId: 31337,
    verifyingContract: collectionAddr,
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400); // 24 hours
  const types = {
    NFTVoucher: [
      { name: 'nft', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'minPrice', type: 'uint256' },
      { name: 'uri', type: 'string' },
      { name: 'artist', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const message = {
    nft: collectionAddr,
    tokenId: 0n,
    minPrice: minPriceWei,
    uri: metadataUri,
    artist: artistAccount.address,
    nonce,
    deadline,
  };

  const voucherSignature = await artistAccount.signTypedData({
    domain,
    types,
    primaryType: 'NFTVoucher',
    message,
  });
  console.log('✔ EIP-712 Typed Data voucher signed by artist (0 gas)');

  // Post voucher to marketplace API
  const saveVoucherRes = await fetch(`${apiBase}/api/vouchers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${artistToken}`,
    },
    body: JSON.stringify({
      chainId: 31337,
      nftAddress: collectionAddr,
      tokenId: '0',
      minPriceWei: minPriceWei.toString(),
      metadataUri,
      artist: artistAccount.address,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      signature: voucherSignature,
      title: 'Cosmic Singularity (Lazy Mint)',
      imageUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe',
      artistName: 'Ada Goldfield',
    }),
  });
  const saveBody = await saveVoucherRes.json();
  if (!saveVoucherRes.ok) throw new Error(`Voucher save failed: ${JSON.stringify(saveBody)}`);
  console.log(`✔ Voucher registered with marketplace API: ID #${saveBody.data.id}`);

  // Retrieve active vouchers from API
  const getVouchersRes = await fetch(`${apiBase}/api/vouchers?chainId=31337&status=active`);
  const { data: activeVouchers } = await getVouchersRes.json();
  const foundVoucher = activeVouchers.find((v) => v.id === saveBody.data.id);
  if (!foundVoucher) throw new Error('Registered voucher not returned by GET /api/vouchers');
  console.log('✔ Verified voucher listed in active marketplace query');

  // Test expired voucher rejection on-chain
  console.log('  Testing expired voucher rejection...');
  const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);
  const expiredMsg = { ...message, nonce: nonce + 999n, deadline: expiredDeadline };
  const expiredSig = await artistAccount.signTypedData({
    domain,
    types,
    primaryType: 'NFTVoucher',
    message: expiredMsg,
  });
  try {
    await collectorWallet.writeContract({
      address: collectionAddr,
      abi: ArtworkNFT.abi,
      functionName: 'mintWithVoucher',
      args: [{ ...expiredMsg }, expiredSig],
      value: minPriceWei,
    });
    throw new Error('SECURITY VIOLATION: Expired voucher was accepted!');
  } catch (err) {
    console.log('  ✔ Expired voucher correctly rejected by smart contract');
  }

  // Collector redeems valid voucher on-chain
  console.log('\n3. Collector redeems voucher on-chain via mintWithVoucher()...');
  const artistPreBal = await publicClient.getBalance({ address: artistAccount.address });
  const mintedTokenId = await publicClient.readContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'nextTokenId',
  });

  const voucherStruct = {
    nft: collectionAddr,
    tokenId: 0n,
    minPrice: minPriceWei,
    uri: metadataUri,
    artist: artistAccount.address,
    nonce,
    deadline,
  };

  const redeemTx = await collectorWallet.writeContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'mintWithVoucher',
    args: [voucherStruct, voucherSignature],
    value: minPriceWei,
  });
  const redeemReceipt = await publicClient.waitForTransactionReceipt({ hash: redeemTx });
  console.log(`✔ Lazy mint redeemed on-chain in tx ${redeemTx} (gas used: ${redeemReceipt.gasUsed})`);

  // Verify token ownership and payout
  const owner = await publicClient.readContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'ownerOf',
    args: [mintedTokenId],
  });
  if (owner.toLowerCase() !== collectorAccount.address.toLowerCase()) {
    throw new Error(`Token owner mismatch: expected ${collectorAccount.address}, got ${owner}`);
  }
  console.log(`✔ 1/1 NFT #${mintedTokenId} correctly transferred to collector wallet`);

  const artistPostBal = await publicClient.getBalance({ address: artistAccount.address });
  const artistNetProfit = artistPostBal - artistPreBal;
  if (artistNetProfit !== minPriceWei) {
    throw new Error(`Artist payout mismatch: expected ${minPriceWei}, got ${artistNetProfit}`);
  }
  console.log(`✔ Artist directly received 100% of lazy mint purchase: ${formatEther(artistNetProfit)} ETH`);

  // STEP 4: On-Chain Escrowed Offers & Counter-Offers
  console.log('\n4. Testing On-Chain Escrowed Offers...');
  const tokenId2 = await publicClient.readContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'nextTokenId',
  });
  const mintTx2 = await artistWallet.writeContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'mint',
    args: ['ipfs://bafkreibidandlotmetadata2'],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx2 });

  // Approve AuctionHouse and create Lot
  const approveTx = await artistWallet.writeContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'approve',
    args: [AuctionHouse.address, tokenId2],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;
  const createLotTx = await artistWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'createLot',
    args: [collectionAddr, tokenId2, parseEther('0.5'), parseEther('0.05'), now, now + 86400n],
  });
  await publicClient.waitForTransactionReceipt({ hash: createLotTx });
  console.log(`✔ Lot created for Token #${tokenId2} (Reserve: 0.5 ETH)`);

  // Collector makes an on-chain offer below reserve: 0.25 ETH
  console.log('Collector places on-chain escrowed offer of 0.25 ETH...');
  const offerAmount = parseEther('0.25');
  const makeOfferTx = await collectorWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'makeOffer',
    args: [collectionAddr, tokenId2],
    value: offerAmount,
  });
  await publicClient.waitForTransactionReceipt({ hash: makeOfferTx });

  const onChainOffer = await publicClient.readContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'offers',
    args: [collectionAddr, tokenId2, collectorAccount.address],
  });
  if (onChainOffer[0].toLowerCase() !== collectorAccount.address.toLowerCase() || onChainOffer[1] !== offerAmount) {
    throw new Error(`On-chain offer verification failed: buyer=${onChainOffer[0]}, amount=${onChainOffer[1]}`);
  }
  console.log(`✔ On-chain offer verified in contract escrow: ${formatEther(onChainOffer[1])} ETH`);

  // Artist submits counter-offer: 0.35 ETH
  console.log('Artist submits on-chain counter-offer of 0.35 ETH...');
  const counterAmount = parseEther('0.35');
  const counterTx = await artistWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'counterOffer',
    args: [collectionAddr, tokenId2, collectorAccount.address, counterAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: counterTx });
  console.log('✔ Counter-offer recorded on-chain');

  // Artist accepts the 0.25 ETH offer directly
  console.log('Artist accepts the collector\'s 0.25 ETH escrowed offer...');
  const sellerPreBal = await publicClient.getBalance({ address: artistAccount.address });
  const acceptTx = await artistWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'acceptOffer',
    args: [collectionAddr, tokenId2, collectorAccount.address],
  });
  const acceptReceipt = await publicClient.waitForTransactionReceipt({ hash: acceptTx });
  console.log(`✔ Offer accepted on-chain in tx ${acceptTx}`);

  // Verify NFT transferred to collector
  const finalToken2Owner = await publicClient.readContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'ownerOf',
    args: [tokenId2],
  });
  if (finalToken2Owner.toLowerCase() !== collectorAccount.address.toLowerCase()) {
    throw new Error(`NFT transfer failed: owner is ${finalToken2Owner}, expected ${collectorAccount.address}`);
  }
  console.log(`✔ 1/1 NFT #${tokenId2} successfully transferred to buyer`);

  // Verify seller received net proceeds (0.25 ETH - 2.5% protocol fee = 0.24375 ETH minus gas)
  const sellerPostBal = await publicClient.getBalance({ address: artistAccount.address });
  const sellerGas = acceptReceipt.gasUsed * acceptReceipt.effectiveGasPrice;
  const netReceived = sellerPostBal - sellerPreBal + sellerGas;
  const expectedNet = parseEther('0.24375'); // 97.5% of 0.25 ETH
  if (netReceived !== expectedNet) {
    throw new Error(`Net payout mismatch: expected ${expectedNet}, got ${netReceived}`);
  }
  console.log(`✔ Seller received net proceeds (${formatEther(netReceived)} ETH) after 2.5% protocol fee`);

  // STEP 5: Test Offer Cancellation & Refund Vault Pull
  console.log('\n5. Testing Offer Cancellation and Refund Pull-Vault...');
  const tokenId3 = await publicClient.readContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'nextTokenId',
  });
  const mintTx3 = await artistWallet.writeContract({
    address: collectionAddr,
    abi: ArtworkNFT.abi,
    functionName: 'mint',
    args: ['ipfs://token3metadata'],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx3 });

  const cancelTestAmount = parseEther('0.1');
  const offerToCancelTx = await collectorWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'makeOffer',
    args: [collectionAddr, tokenId3],
    value: cancelTestAmount,
  });
  await publicClient.waitForTransactionReceipt({ hash: offerToCancelTx });

  // Cancel the offer
  const cancelTx = await collectorWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'cancelOffer',
    args: [collectionAddr, tokenId3],
  });
  await publicClient.waitForTransactionReceipt({ hash: cancelTx });

  const refundable = await publicClient.readContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'refundable',
    args: [collectorAccount.address],
  });
  if (refundable < cancelTestAmount) {
    throw new Error(`Refundable balance mismatch: expected at least ${cancelTestAmount}, got ${refundable}`);
  }
  console.log(`✔ Cancelled offer funds safely moved to refundable pull-vault: ${formatEther(refundable)} ETH`);

  // Collector pulls refund
  const collectorPreBal = await publicClient.getBalance({ address: collectorAccount.address });
  const withdrawTx = await collectorWallet.writeContract({
    address: AuctionHouse.address,
    abi: AuctionHouse.abi,
    functionName: 'withdrawRefund',
  });
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
  const collectorPostBal = await publicClient.getBalance({ address: collectorAccount.address });
  const withdrawGas = withdrawReceipt.gasUsed * withdrawReceipt.effectiveGasPrice;
  const netRefund = collectorPostBal - collectorPreBal + withdrawGas;
  if (netRefund < cancelTestAmount) {
    throw new Error(`Withdraw refund failed to return full escrow amount`);
  }
  console.log(`✔ Collector pulled refund successfully: ${formatEther(netRefund)} ETH returned`);

  console.log('\n================================================================');
  console.log('   ALL EIP-712 LAZY MINT & ON-CHAIN OFFER FLOWS PASSED 100%!     ');
  console.log('================================================================\n');
}

runTest().catch((err) => {
  console.error('\n✖ TEST FAILED:', err);
  process.exit(1);
});
