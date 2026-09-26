import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localhost } from 'viem/chains';
import fs from 'fs';

const RPC_URL = 'http://127.0.0.1:8545';
const DEPLOYMENT_PATH = 'contracts/deployments/31337.json';

const ANVIL_ARTIST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Account 0
const ANVIL_BIDDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Account 1
const ANVIL_BUYER_KEY  = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Account 2

async function main() {
  console.log('--- TEST BUY NOW (INSTANT SETTLE) FLOW ---');

  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error('Deployment file not found at ' + DEPLOYMENT_PATH);
  }
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
  const auctionAddr = deployment.contracts.AuctionHouse.address;
  const auctionAbi = deployment.contracts.AuctionHouse.abi;
  const factoryAddr = deployment.contracts.ArtistFactory.address;
  const factoryAbi = deployment.contracts.ArtistFactory.abi;

  const publicClient = createPublicClient({ chain: localhost, transport: http(RPC_URL) });
  const artistAccount = privateKeyToAccount(ANVIL_ARTIST_KEY);
  const bidderAccount = privateKeyToAccount(ANVIL_BIDDER_KEY);
  const buyerAccount  = privateKeyToAccount(ANVIL_BUYER_KEY);

  const artistWallet = createWalletClient({ account: artistAccount, chain: localhost, transport: http(RPC_URL) });
  const bidderWallet = createWalletClient({ account: bidderAccount, chain: localhost, transport: http(RPC_URL) });
  const buyerWallet  = createWalletClient({ account: buyerAccount, chain: localhost, transport: http(RPC_URL) });

  const initialRef = await publicClient.readContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'refundable',
    args: [bidderAccount.address],
  });

  // 1. Check or create artist collection
  let collectionAddr = await publicClient.readContract({
    address: factoryAddr,
    abi: factoryAbi,
    functionName: 'collectionOf',
    args: [artistAccount.address],
  });

  if (!collectionAddr || collectionAddr === '0x0000000000000000000000000000000000000000') {
    console.log('Creating artist collection...');
    const collTx = await artistWallet.writeContract({
      address: factoryAddr,
      abi: factoryAbi,
      functionName: 'createCollection',
      args: ['BuyNow Masterpieces', 'BNM'],
    });
    await publicClient.waitForTransactionReceipt({ hash: collTx });
    collectionAddr = await publicClient.readContract({
      address: factoryAddr,
      abi: factoryAbi,
      functionName: 'collectionOf',
      args: [artistAccount.address],
    });
  }
  console.log('Artist collection address:', collectionAddr);

  // 2. Mint 1/1 NFT
  const artworkAbi = deployment.contracts.ArtworkNFT.abi;
  const nextTokenId = await publicClient.readContract({
    address: collectionAddr,
    abi: artworkAbi,
    functionName: 'nextTokenId',
  });
  console.log(`Minting token #${nextTokenId}...`);
  const mintTx = await artistWallet.writeContract({
    address: collectionAddr,
    abi: artworkAbi,
    functionName: 'mint',
    args: ['ipfs://bafybeibuynowtest123'],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });

  // 3. Approve AuctionHouse
  const approveTx = await artistWallet.writeContract({
    address: collectionAddr,
    abi: artworkAbi,
    functionName: 'approve',
    args: [auctionAddr, nextTokenId],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // 4. Create Lot with Buy Now
  // Reserve: 0.1 ETH, MinIncrement: 0.01 ETH, BuyNow: 0.5 ETH
  const reservePrice = parseEther('0.1');
  const minInc = parseEther('0.01');
  const buyNowPrice = parseEther('0.5');
  const now = BigInt(Math.floor(Date.now() / 1000));
  const endTime = now + 86400n;

  console.log('Creating lot with Buy Now: 0.5 ETH, Reserve: 0.1 ETH...');
  const createTx = await artistWallet.writeContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'createLotWithBuyNow',
    args: [collectionAddr, nextTokenId, reservePrice, minInc, now, endTime, buyNowPrice],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });

  // Read nextLotId - 1 to get created lotId
  const nextLotId = await publicClient.readContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'nextLotId',
  });
  const lotId = nextLotId - 1n;
  console.log(`Created Lot #${lotId}`);

  // 5. Bidder 1 places a bid of 0.2 ETH
  console.log('Bidder 1 placing bid of 0.2 ETH...');
  const bidTx = await bidderWallet.writeContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'placeBid',
    args: [lotId],
    value: parseEther('0.2'),
  });
  await publicClient.waitForTransactionReceipt({ hash: bidTx });
  console.log('Bidder 1 bid confirmed.');

  // 6. Buyer invokes buyNow with 0.5 ETH
  console.log('Buyer invoking buyNow with 0.5 ETH (Instant Settle)...');
  const buyTx = await buyerWallet.writeContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'buyNow',
    args: [lotId],
    value: buyNowPrice,
  });
  const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyTx });
  console.log(`Buy Now transaction successful: ${buyReceipt.transactionHash}`);

  // 7. Verify Ownership of NFT transferred to buyer
  const owner = await publicClient.readContract({
    address: collectionAddr,
    abi: artworkAbi,
    functionName: 'ownerOf',
    args: [nextTokenId],
  });
  console.log('New NFT owner on-chain:', owner);
  if (owner.toLowerCase() !== buyerAccount.address.toLowerCase()) {
    throw new Error(`Owner mismatch! Expected ${buyerAccount.address}, got ${owner}`);
  }

  // 8. Verify Bidder 1 received 0.2 ETH refundable
  const ref = await publicClient.readContract({
    address: auctionAddr,
    abi: auctionAbi,
    functionName: 'refundable',
    args: [bidderAccount.address],
  });
  console.log(`Bidder 1 refundable balance: ${formatEther(ref)} ETH (was ${formatEther(initialRef)} ETH)`);
  if (ref - initialRef !== parseEther('0.2')) {
    throw new Error(`Expected refundable delta of 0.2 ETH, got ${formatEther(ref - initialRef)}`);
  }

  console.log('✔ BUY NOW FLOW TEST PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
