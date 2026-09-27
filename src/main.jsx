import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPublicClient, createWalletClient, custom, http, parseEther, formatEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, base, baseSepolia, foundry } from 'viem/chains';
import './styles.css';

const isDevMode = import.meta.env.DEV || import.meta.env.VITE_DEV_MODE === 'true';

// ────────────────────────────────────────────────────────────────────────────
// ENS name cache — resolves on mainnet only in production (zero cloud calls in dev mode)
// ────────────────────────────────────────────────────────────────────────────
const ensCache = new Map();
let ensMainnetClient = null;
if (!isDevMode) {
  try {
    ensMainnetClient = createPublicClient({ chain: mainnet, transport: http('https://eth.llamarpc.com') });
  } catch {}
}

async function resolveEns(address) {
  if (isDevMode || !ensMainnetClient || !address || address.length !== 42) return null;
  const key = address.toLowerCase();
  if (ensCache.has(key)) return ensCache.get(key);
  ensCache.set(key, null); // placeholder so we don't fire duplicate requests
  try {
    const name = await ensMainnetClient.getEnsName({ address: key });
    ensCache.set(key, name || null);
    return name || null;
  } catch {
    return null;
  }
}

function useEnsName(address) {
  const [name, setName] = useState(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    resolveEns(address).then((n) => { if (!cancelled) setName(n); });
    return () => { cancelled = true; };
  }, [address]);
  return name;
}

function AddrDisplay({ address, explorer }) {
  const ens = useEnsName(address);
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const label = ens || short;
  if (explorer && address) {
    return <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address} style={{color:'inherit',textDecoration:'none'}}>{label}</a>;
  }
  return <span title={address}>{label}</span>;
}

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';
const envRpcUrl = import.meta.env.VITE_RPC_URL || 'http://127.0.0.1:8545';
const defaultAuctionMinIncrement = import.meta.env.VITE_DEFAULT_AUCTION_MIN_INCREMENT_ETH || '';

// Supported Ethereum & EVM Networks
export const NETWORKS = {
  11155111: {
    id: 11155111,
    name: 'Ethereum Sepolia',
    shortName: 'Sepolia',
    chain: sepolia,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    currency: 'ETH',
    testnet: true,
  },
  1: {
    id: 1,
    name: 'Ethereum Mainnet',
    shortName: 'Mainnet',
    chain: mainnet,
    rpcUrl: 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io',
    currency: 'ETH',
    testnet: false,
  },
  84532: {
    id: 84532,
    name: 'Base Sepolia',
    shortName: 'Base Sepolia',
    chain: baseSepolia,
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    currency: 'ETH',
    testnet: true,
  },
  8453: {
    id: 8453,
    name: 'Base',
    shortName: 'Base',
    chain: base,
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    currency: 'ETH',
    testnet: false,
  },
  31337: {
    id: 31337,
    name: 'Anvil Localhost',
    shortName: 'Local Anvil',
    chain: foundry,
    rpcUrl: envRpcUrl,
    explorer: '',
    currency: 'ETH',
    testnet: true,
  },
};

// Local Anvil Accounts for Developer Testing Mode (tree-shaken out in production builds)
const ANVIL_ACCOUNTS = import.meta.env.DEV
  ? [
      {
        name: 'Account 0 (Deployer / Artist)',
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        role: 'Artist & Admin',
      },
      {
        name: 'Account 1 (Collector Alice)',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
        role: 'Primary Collector',
      },
      {
        name: 'Account 2 (Collector Bob)',
        address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
        role: 'Secondary Collector',
      },
    ]
  : [];

// Dynamic cosmetic ETH/USD price tracker (only used for UI display badges, never in consensus)
let liveEthUsdRate = 2600;
if (typeof window !== 'undefined' && !isDevMode) {
  fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
    .then((res) => res.json())
    .then((payload) => {
      const parsed = parseFloat(payload?.data?.amount);
      if (!isNaN(parsed) && parsed > 0) liveEthUsdRate = parsed;
    })
    .catch(() => {});
}

function formatUsd(ethVal) {
  if (!ethVal || ethVal === '0') return '$0';
  const num = parseFloat(ethVal);
  if (isNaN(num)) return '';
  return `$${Math.round(num * liveEthUsdRate).toLocaleString()}`;
}

function formatEthAndUsd(ethVal) {
  if (!ethVal || ethVal === '0') return '0 ETH ($0)';
  const num = parseFloat(ethVal);
  if (isNaN(num)) return `${ethVal} ETH`;
  return `${ethVal} ETH (${formatUsd(ethVal)})`;
}

function formatTimeRemaining(endTime) {
  const diff = new Date(endTime).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const mins = Math.floor((diff / (1000 * 60)) % 60);
  const secs = Math.floor((diff / 1000) % 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m ${secs}s`;
}

function App() {
  const [activeChainId, setActiveChainId] = useState(31337);
  const activeNetwork = useMemo(() => NETWORKS[activeChainId] || NETWORKS[31337], [activeChainId]);

  const [lotsState, setLotsState] = useState({ status: 'loading', lots: [], error: '' });
  const [deployment, setDeployment] = useState(null);
  const [selectedLot, setSelectedLot] = useState(null);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showCreateDropModal, setShowCreateDropModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [activeView, setActiveView] = useState('market'); // 'market', 'artist-studio'

  const [activeAccount, setActiveAccount] = useState(ANVIL_ACCOUNTS[0]);
  const [accountBalance, setAccountBalance] = useState('0.00');
  const [refundableEth, setRefundableEth] = useState('0.00');
  const [session, setSession] = useState(() => {
    try {
      const stored = localStorage.getItem('patronage_session');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [bidInput, setBidInput] = useState('');
  const [txPending, setTxPending] = useState(false);
  const [txStep, setTxStep] = useState('');
  const [lastTxHash, setLastTxHash] = useState('');

  // Marketplace filter & search states
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');

  // Create drop form state
  const [dropTitle, setDropTitle] = useState('');
  const [dropDesc, setDropDesc] = useState('');
  const [dropReserve, setDropReserve] = useState('0.1');
  const [dropBuyNow, setDropBuyNow] = useState('');
  const [dropMinIncrement, setDropMinIncrement] = useState(defaultAuctionMinIncrement || '0.01');
  const [dropDurationHours, setDropDurationHours] = useState('24');
  const [dropImageFile, setDropImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);

  // Museum Gallery & Cinema Lightbox states
  const [lightboxImage, setLightboxImage] = useState(null);
  const [lightboxTitle, setLightboxTitle] = useState('');
  const [lightboxArtist, setLightboxArtist] = useState('');
  const [isZoomed, setIsZoomed] = useState(false);
  const [viewingArtist, setViewingArtist] = useState(null);
  const [modalTab, setModalTab] = useState('provenance'); // 'provenance' or 'bids'

  // Notification bell state
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const lastSeenNotifRef = useRef(null);

  // Artist application modal
  const [showArtistApplyModal, setShowArtistApplyModal] = useState(false);
  const [applyHandle, setApplyHandle] = useState('');
  const [applyDisplayName, setApplyDisplayName] = useState('');
  const [applyBio, setApplyBio] = useState('');
  const [applyPending, setApplyPending] = useState(false);

  // Secondary resale (list for sale) modal
  const [showRelistModal, setShowRelistModal] = useState(false);
  const [relistNftAddress, setRelistNftAddress] = useState('');
  const [relistTokenId, setRelistTokenId] = useState('');
  const [relistReserve, setRelistReserve] = useState('0.1');
  const [relistBuyNow, setRelistBuyNow] = useState('');
  const [relistDuration, setRelistDuration] = useState('24');
  const [relistMinIncrement, setRelistMinIncrement] = useState('0.01');
  const [relistPrefillTitle, setRelistPrefillTitle] = useState('');

  // On-Chain Escrowed Offers & Counter-Offers state
  const [offers, setOffers] = useState([]);
  const [offerInput, setOfferInput] = useState('');
  const [counterInput, setCounterInput] = useState('');
  const [counteringOffer, setCounteringOffer] = useState(null);

  // EIP-712 Gasless Lazy Minting state
  const [vouchers, setVouchers] = useState([]);
  const [dropMode, setDropMode] = useState('auction'); // 'auction' | 'lazy'
  const [selectedVoucher, setSelectedVoucher] = useState(null);

  // Multi-Wallet & WalletConnect state
  const [showWalletConnectModal, setShowWalletConnectModal] = useState(false);
  const [wcPairingUri, setWcPairingUri] = useState('');

  // Collector profile tab
  const [profileData, setProfileData] = useState(null);
  const [profileTab, setProfileTab] = useState('created'); // 'created' | 'bids' | 'notifications'

  // Live countdown ticker state (ticks every second)
  const [currentTime, setCurrentTime] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Server-Sent Events (SSE) live updates
  useEffect(() => {
    try {
      const source = new EventSource(`${apiBase}/api/stream`);
      source.addEventListener('lots_updated', () => {
        void loadLots();
        void updateAccountDetails();
      });
      return () => source.close();
    } catch {}
  }, [apiBase, activeChainId]);

  // Public Viem Client corresponding to current network
  const publicClient = useMemo(() => {
    return createPublicClient({
      chain: activeNetwork.chain,
      transport: http(activeNetwork.rpcUrl),
    });
  }, [activeNetwork]);

  function getWalletClient() {
    if (activeAccount?.isBrowserWallet && typeof window !== 'undefined' && window.ethereum) {
      return createWalletClient({
        account: activeAccount.address,
        chain: activeNetwork.chain,
        transport: custom(window.ethereum),
      });
    }
    const account = privateKeyToAccount(activeAccount.privateKey);
    return createWalletClient({ account, chain: activeNetwork.chain, transport: http(activeNetwork.rpcUrl) });
  }

  // Load deployment manifest for current chain
  async function loadDeployment() {
    try {
      const res = await fetch(`${apiBase}/api/deployment?chainId=${activeNetwork.id}`);
      if (res.ok) {
        const body = await res.json();
        setDeployment(body.data);
      } else {
        // Fallback to local manifest if network-specific manifest is not yet deployed
        const fallbackRes = await fetch(`${apiBase}/api/deployment`);
        if (fallbackRes.ok) {
          const fb = await fallbackRes.json();
          setDeployment(fb.data);
        }
      }
    } catch (err) {
      console.warn('[app] Could not fetch deployment manifest:', err.message);
    }
  }

  // Load lots from indexer database (paginated)
  async function loadLots(opts = {}) {
    try {
      const params = new URLSearchParams({
        page: String(opts.page || 1),
        limit: '50',
        sort: opts.sort || sortBy,
        ...(opts.q   !== undefined ? { q: opts.q }       : searchQuery ? { q: searchQuery } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : statusFilter && statusFilter !== 'all' ? { status: statusFilter } : {}),
      });
      const response = await fetch(`${apiBase}/api/lots?${params}`, { headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'The marketplace service is unavailable.');
      setLotsState({ status: 'ready', lots: body.data, error: '', meta: body.meta });
    } catch (error) {
      setLotsState({ status: 'error', lots: [], error: error instanceof Error ? error.message : 'The marketplace service is unavailable.' });
    }
  }

  // Update ETH balance & refundable outbid funds
  async function updateAccountDetails() {
    if (!activeAccount) return;
    try {
      const bal = await publicClient.getBalance({ address: activeAccount.address });
      setAccountBalance(parseFloat(formatEther(bal)).toFixed(4));

      if (deployment?.contracts?.AuctionHouse) {
        const ref = await publicClient.readContract({
          address: deployment.contracts.AuctionHouse.address,
          abi: deployment.contracts.AuctionHouse.abi,
          functionName: 'refundable',
          args: [activeAccount.address],
        });
        setRefundableEth(formatEther(ref));
      }
    } catch (err) {
      console.warn('[app] Error fetching balance:', err.message);
    }
  }

  // Load on-chain escrowed offers for lot/token
  async function loadOffers(nftAddress, tokenId) {
    if (!nftAddress || !tokenId) return;
    try {
      const res = await fetch(`${apiBase}/api/offers?chainId=${activeNetwork.id}&nftAddress=${nftAddress}&tokenId=${tokenId}`);
      if (res.ok) {
        const body = await res.json();
        setOffers(body.data || []);
      }
    } catch {}
  }

  // Load gasless lazy mint vouchers
  async function loadVouchers() {
    try {
      const res = await fetch(`${apiBase}/api/vouchers?chainId=${activeNetwork.id}&status=active`);
      if (res.ok) {
        const body = await res.json();
        setVouchers(body.data || []);
      }
    } catch {}
  }

  useEffect(() => {
    if (selectedLot) {
      void loadOffers(selectedLot.nftAddress, selectedLot.tokenId);
    }
  }, [selectedLot]);

  useEffect(() => {
    void loadVouchers();
  }, [activeChainId]);

  // On-Chain Escrowed Make Offer
  async function handleMakeOffer(lot) {
    if (!offerInput || parseFloat(offerInput) <= 0) {
      alert('Please enter a valid ETH offer amount.');
      return;
    }
    setTxPending(true);
    setTxStep(`Escrowing ${offerInput} ETH on-chain offer for Lot #${lot.lotId}...`);
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'makeOffer',
        args: [lot.nftAddress, BigInt(lot.tokenId)],
        value: parseEther(offerInput),
      });
      setLastTxHash(hash);
      setTxStep('Awaiting block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      setOfferInput('');
      await loadOffers(lot.nftAddress, lot.tokenId);
      await updateAccountDetails();
      alert(`Offer of ${offerInput} ETH successfully escrowed on-chain!`);
    } catch (err) {
      console.error('[app] Make offer error:', err);
      alert(`Make offer failed: ${err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Cancel On-Chain Offer
  async function handleCancelOffer(lot) {
    if (!confirm('Cancel your escrowed offer? Funds will be moved to your refundable pull-vault.')) return;
    setTxPending(true);
    setTxStep('Cancelling offer and releasing escrow to refund vault...');
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'cancelOffer',
        args: [lot.nftAddress, BigInt(lot.tokenId)],
      });
      setLastTxHash(hash);
      setTxStep('Awaiting block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      await loadOffers(lot.nftAddress, lot.tokenId);
      await updateAccountDetails();
      alert('Offer cancelled. Escrowed ETH moved to your refundable vault.');
    } catch (err) {
      console.error('[app] Cancel offer error:', err);
      alert(`Cancel offer failed: ${err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Seller Counter-Offer
  async function handleCounterOffer(lot, offer) {
    const counterAmount = prompt(`Counter ${offer.buyer.slice(0, 6)}…'s offer of ${offer.amountEth} ETH with (in ETH):`);
    if (!counterAmount || parseFloat(counterAmount) <= 0) return;
    setTxPending(true);
    setTxStep(`Setting on-chain counter-offer of ${counterAmount} ETH...`);
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'counterOffer',
        args: [lot.nftAddress, BigInt(lot.tokenId), offer.buyer, parseEther(counterAmount)],
      });
      setLastTxHash(hash);
      setTxStep('Awaiting block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      await loadOffers(lot.nftAddress, lot.tokenId);
      alert(`Counter-offer of ${counterAmount} ETH recorded on-chain!`);
    } catch (err) {
      console.error('[app] Counter offer error:', err);
      alert(`Counter offer failed: ${err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Seller Accept Offer
  async function handleAcceptOffer(lot, offer) {
    if (!confirm(`Accept ${offer.buyer.slice(0, 6)}…'s offer of ${offer.amountEth} ETH? The NFT will be transferred immediately.`)) return;
    setTxPending(true);
    setTxStep(`Accepting offer of ${offer.amountEth} ETH on-chain...`);
    try {
      const walletClient = getWalletClient();

      const currentOwner = await publicClient.readContract({
        address: lot.nftAddress,
        abi: deployment.contracts.ArtworkNFT.abi,
        functionName: 'ownerOf',
        args: [BigInt(lot.tokenId)],
      }).catch(() => null);

      if (currentOwner && currentOwner.toLowerCase() === activeAccount.address.toLowerCase()) {
        setTxStep('Approving AuctionHouse for token transfer...');
        const approveHash = await walletClient.writeContract({
          address: lot.nftAddress,
          abi: deployment.contracts.ArtworkNFT.abi,
          functionName: 'approve',
          args: [lot.auctionAddress, BigInt(lot.tokenId)],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setTxStep('Executing offer acceptance and payout on-chain...');
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'acceptOffer',
        args: [lot.nftAddress, BigInt(lot.tokenId), offer.buyer],
      });
      setLastTxHash(hash);
      setTxStep('Awaiting block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      await loadOffers(lot.nftAddress, lot.tokenId);
      await loadLots();
      await updateAccountDetails();
      alert(`Offer accepted! Sold for ${offer.amountEth} ETH. Net proceeds disbursed on-chain.`);
      setSelectedLot(null);
    } catch (err) {
      console.error('[app] Accept offer error:', err);
      alert(`Accept offer failed: ${err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Collector Redeems Lazy Mint Voucher
  async function handleMintVoucher(voucher) {
    setTxPending(true);
    setTxStep(`Minting 1/1 artwork via artist's gasless voucher (${voucher.minPriceEth} ETH)...`);
    try {
      const walletClient = getWalletClient();
      const voucherStruct = {
        nft: voucher.nftAddress,
        tokenId: BigInt(voucher.tokenId || '0'),
        minPrice: BigInt(voucher.minPriceWei),
        uri: voucher.metadataUri,
        artist: voucher.artist,
        nonce: BigInt(voucher.nonce),
        deadline: BigInt(voucher.deadline || (Math.floor(Date.now() / 1000) + 86400).toString()),
      };

      const hash = await walletClient.writeContract({
        address: voucher.nftAddress,
        abi: deployment.contracts.ArtworkNFT.abi,
        functionName: 'mintWithVoucher',
        args: [voucherStruct, voucher.signature],
        value: BigInt(voucher.minPriceWei),
      });

      setLastTxHash(hash);
      setTxStep('Awaiting block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      await loadVouchers();
      await loadLots();
      await updateAccountDetails();
      setSelectedVoucher(null);
      alert(`🎉 Congratulations! You have minted & collected "${voucher.title || 'Artwork'}"!`);
    } catch (err) {
      console.error('[app] Mint voucher error:', err);
      alert(`Minting voucher failed: ${err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Detect and synchronize browser wallet chain changes
  useEffect(() => {
    if (typeof window !== 'undefined' && window.ethereum) {
      window.ethereum.request({ method: 'eth_chainId' }).then((hexId) => {
        const id = parseInt(hexId, 16);
        if (NETWORKS[id]) setActiveChainId(id);
      }).catch(() => {});

      const handleChainChanged = (hexId) => {
        const id = parseInt(hexId, 16);
        if (NETWORKS[id]) setActiveChainId(id);
      };

      const handleAccountsChanged = (accounts) => {
        if (accounts.length > 0) {
          setActiveAccount({
            name: `Wallet (${accounts[0].slice(0, 6)}…)`,
            address: accounts[0],
            isBrowserWallet: true,
            role: 'Injected Signer',
          });
        }
      };

      window.ethereum.on?.('chainChanged', handleChainChanged);
      window.ethereum.on?.('accountsChanged', handleAccountsChanged);

      return () => {
        window.ethereum.removeListener?.('chainChanged', handleChainChanged);
        window.ethereum.removeListener?.('accountsChanged', handleAccountsChanged);
      };
    }
  }, []);

  useEffect(() => {
    void loadDeployment();
    void loadLots();
    const interval = setInterval(() => void loadLots(), 4000);
    return () => clearInterval(interval);
  }, [activeChainId]);

  // Load authenticated user's notifications
  async function loadNotifications() {
    if (!session) return;
    try {
      const res = await fetch(`${apiBase}/api/notifications`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!res.ok) return;
      const body = await res.json();
      const items = body.data || [];
      setNotifications(items);
      // Count notifications newer than the last-seen marker
      if (lastSeenNotifRef.current === null && items.length > 0) {
        lastSeenNotifRef.current = items[0].createdAt;
        setUnreadCount(0);
      } else if (items.length > 0) {
        const unseen = items.filter((n) => new Date(n.createdAt) > new Date(lastSeenNotifRef.current || 0));
        setUnreadCount(unseen.length);
      }
    } catch {}
  }

  // Poll notifications every 15 seconds when authenticated
  useEffect(() => {
    if (!session) return;
    void loadNotifications();
    const interval = setInterval(() => void loadNotifications(), 15000);
    return () => clearInterval(interval);
  }, [session]);

  // Load full profile when profile modal opens
  async function loadProfile() {
    if (!activeAccount?.address) return;
    try {
      const res = await fetch(`${apiBase}/api/profile/${activeAccount.address}`);
      if (!res.ok) return;
      const body = await res.json();
      setProfileData(body.data);
    } catch {}
  }

  useEffect(() => {
    void updateAccountDetails();
  }, [activeAccount, deployment, activeNetwork]);

  // Network Switcher
  async function switchNetwork(targetChainId) {
    const target = NETWORKS[targetChainId];
    if (!target) return;
    if (activeAccount?.isBrowserWallet && typeof window !== 'undefined' && window.ethereum) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: toHex(targetChainId) }],
        });
        setActiveChainId(targetChainId);
        setShowNetworkModal(false);
      } catch (switchError) {
        // If chain is not added to user's wallet
        if (switchError.code === 4902 && target.testnet && targetChainId !== 31337) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: toHex(targetChainId),
                  chainName: target.name,
                  rpcUrls: [target.rpcUrl],
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                  blockExplorerUrls: target.explorer ? [target.explorer] : [],
                },
              ],
            });
            setActiveChainId(targetChainId);
            setShowNetworkModal(false);
          } catch (addError) {
            alert(`Could not add network: ${addError.message}`);
          }
        } else {
          alert(`Network switch failed: ${switchError.message}`);
        }
      }
    } else {
      setActiveChainId(targetChainId);
      setShowNetworkModal(false);
    }
  }

  // Multi-Wallet Connection (MetaMask, Coinbase Wallet, WalletConnect v2, Rabby)
  async function connectWalletType(type) {
    if (type === 'walletconnect') {
      const simulatedUri = `wc:patronage-${Date.now()}@2?relay-protocol=irn&symKey=0x${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
      setWcPairingUri(simulatedUri);
      setShowWalletModal(false);
      setShowWalletConnectModal(true);
      return;
    }

    let provider = null;
    if (typeof window !== 'undefined') {
      if (type === 'coinbase') {
        provider = window.coinbaseWalletExtension || (window.ethereum?.isCoinbaseWallet ? window.ethereum : null);
      } else if (type === 'rabby') {
        provider = window.rabby || (window.ethereum?.isRabby ? window.ethereum : null);
      }
      if (!provider && window.ethereum) {
        provider = window.ethereum;
      }
    }

    if (!provider) {
      if (type === 'coinbase') {
        window.open('https://www.coinbase.com/wallet', '_blank');
        return;
      }
      alert('No Web3 browser wallet extension detected. Please install MetaMask, Coinbase Wallet, or Rabby.');
      return;
    }

    try {
      const [address] = await provider.request({ method: 'eth_requestAccounts' });
      const hexId = await provider.request({ method: 'eth_chainId' });
      const currentChainId = parseInt(hexId, 16);
      if (NETWORKS[currentChainId]) {
        setActiveChainId(currentChainId);
      }

      const walletLabel =
        type === 'coinbase' ? 'Coinbase Wallet' :
        type === 'rabby' ? 'Rabby Wallet' :
        'Browser Wallet';

      const acc = {
        name: `${walletLabel} (${address.slice(0, 6)}…)`,
        address,
        isBrowserWallet: true,
        walletType: type,
        role: 'Web3 Signer',
      };
      setActiveAccount(acc);
      setShowWalletModal(false);
      await getOrInitSession(acc);
    } catch (err) {
      alert(`Wallet connection failed: ${err.message}`);
    }
  }

  async function connectBrowserWallet() {
    return connectWalletType('injected');
  }

  // EIP-4361 Sign-In with Ethereum (SIWE)
  async function getOrInitSession(account = activeAccount) {
    if (!account) throw new Error('No active wallet connected.');

    // If valid session already exists for this address, return it
    if (session && session.address?.toLowerCase() === account.address?.toLowerCase() && new Date(session.expiresAt) > new Date()) {
      return session.token;
    }

    setTxStep('Authenticating via EIP-4361 Sign-In With Ethereum (SIWE)...');
    const nonceRes = await fetch(`${apiBase}/api/siwe/nonce`);
    if (!nonceRes.ok) throw new Error('Could not obtain SIWE nonce from API.');
    const { nonce } = await nonceRes.json();

    const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4173';

    const siweMessage = `${host} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Patronage NFT Marketplace.\n\nURI: ${origin}\nVersion: 1\nChain ID: ${activeNetwork.id}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;

    let signature = '';
    if (account.isBrowserWallet && typeof window !== 'undefined' && window.ethereum) {
      signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [siweMessage, account.address],
      });
    } else {
      const walletClient = getWalletClient();
      signature = await walletClient.signMessage({ message: siweMessage });
    }

    const verifyRes = await fetch(`${apiBase}/api/siwe/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: account.address,
        message: siweMessage,
        signature,
        nonce,
      }),
    });

    if (!verifyRes.ok) {
      const errBody = await verifyRes.json().catch(() => ({}));
      throw new Error(errBody.message || 'SIWE cryptographic verification failed.');
    }

    const { session: newSession } = await verifyRes.json();
    setSession(newSession);
    try {
      localStorage.setItem('patronage_session', JSON.stringify(newSession));
    } catch {}

    return newSession.token;
  }

  function handleImageSelect(e) {
    const file = e.target.files[0];
    if (file) {
      setDropImageFile(file);
      setImagePreviewUrl(URL.createObjectURL(file));
    }
  }

  // Create & Mint Artwork Drop Flow
  async function handleCreateDrop(e) {
    e.preventDefault();
    if (!dropTitle || !dropReserve || !dropImageFile) {
      alert('Please fill in artwork title, reserve price, and select an artwork image file.');
      return;
    }
    if (!deployment?.contracts?.AuctionHouse || !deployment?.contracts?.ArtistFactory) {
      alert('Smart contracts not deployed on current network. Run deployment first.');
      return;
    }

    setTxPending(true);
    setLastTxHash('');

    try {
      // 1. Authenticate with SIWE
      setTxStep('Step 1/5: Authenticating with wallet signature (SIWE)...');
      const authToken = await getOrInitSession(activeAccount);

      // 2. Upload asset & generate metadata
      setTxStep('Step 2/5: Uploading artwork asset & generating metadata...');
      const imageBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (evt) => resolve(evt.target.result);
        reader.readAsDataURL(dropImageFile);
      });

      const uploadRes = await fetch(`${apiBase}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          title: dropTitle,
          description: dropDesc,
          filename: dropImageFile.name,
          imageBase64,
          artistName: activeAccount.name,
          artistHandle: activeAccount.address.slice(0, 6),
        }),
      });

      if (!uploadRes.ok) {
        const errJson = await uploadRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Upload failed with HTTP ${uploadRes.status}`);
      }

      const uploadBody = await uploadRes.json();
      const metadataUri = uploadBody.data?.metadataUri;
      if (!metadataUri) throw new Error('API did not return a valid metadata URI.');

      const walletClient = getWalletClient();
      const factoryAddr = deployment.contracts.ArtistFactory.address;
      const factoryAbi = deployment.contracts.ArtistFactory.abi;

      // 3. Resolve artist collection or create new collection
      setTxStep('Step 3/5: Preparing artist collection on-chain...');
      let collectionAddr = await publicClient.readContract({
        address: factoryAddr,
        abi: factoryAbi,
        functionName: 'collectionOf',
        args: [activeAccount.address],
      });

      if (!collectionAddr || collectionAddr === '0x0000000000000000000000000000000000000000') {
        setTxStep('Step 3/5: Deploying artist collection clone (EIP-1167)...');
        const collTx = await walletClient.writeContract({
          address: factoryAddr,
          abi: factoryAbi,
          functionName: 'createCollection',
          args: [`${dropTitle} Collection`, 'ART'],
        });
        setLastTxHash(collTx);
        await publicClient.waitForTransactionReceipt({ hash: collTx });

        collectionAddr = await publicClient.readContract({
          address: factoryAddr,
          abi: factoryAbi,
          functionName: 'collectionOf',
          args: [activeAccount.address],
        });
      }

      // Gasless Lazy Minting Drop (EIP-712 Structured Data Voucher)
      if (dropMode === 'lazy') {
        setTxStep('Step 4/4: Signing gasless EIP-712 mint voucher with artist wallet...');
        const voucherNonce = BigInt(Date.now());
        const minPriceWei = parseEther(dropReserve);

        const domain = {
          name: 'PatronageArtwork',
          version: '1',
          chainId: activeNetwork.id,
          verifyingContract: collectionAddr,
        };
        const voucherDeadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600); // 30-day voucher validity
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
          artist: activeAccount.address,
          nonce: voucherNonce,
          deadline: voucherDeadline,
        };

        let signature;
        if (activeAccount.isBrowserWallet) {
          signature = await walletClient.signTypedData({
            account: activeAccount.address,
            domain,
            types,
            primaryType: 'NFTVoucher',
            message,
          });
        } else {
          const acc = privateKeyToAccount(activeAccount.privateKey);
          signature = await acc.signTypedData({
            domain,
            types,
            primaryType: 'NFTVoucher',
            message,
          });
        }

        setTxStep('Registering gasless voucher with marketplace...');
        const saveRes = await fetch(`${apiBase}/api/vouchers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            chainId: activeNetwork.id,
            nftAddress: collectionAddr,
            tokenId: '0',
            minPriceWei: minPriceWei.toString(),
            metadataUri,
            artist: activeAccount.address,
            nonce: voucherNonce.toString(),
            deadline: voucherDeadline.toString(),
            signature,
            title: dropTitle,
            imageUrl: uploadBody.data?.imageUrl,
            artistName: activeAccount.name,
          }),
        });

        if (!saveRes.ok) throw new Error('Failed to register lazy mint voucher.');

        await loadVouchers();
        alert(`🎉 Gasless Lazy Drop created!\nArtist paid 0 gas.\nCollectors can mint & collect on-chain for ${dropReserve} ETH!`);
        setShowCreateDropModal(false);
        setDropTitle('');
        setDropDesc('');
        setDropBuyNow('');
        setDropImageFile(null);
        setImagePreviewUrl(null);
        return;
      }

      // 4. Mint 1/1 Artwork NFT & approve AuctionHouse
      setTxStep('Step 4/5: Minting 1/1 ArtworkNFT to artist wallet...');
      const artworkAbi = deployment.contracts.ArtworkNFT?.abi || [
        { inputs: [{ internalType: 'string', name: 'metadataUri', type: 'string' }], name: 'mint', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'nonpayable', type: 'function' },
        { inputs: [{ internalType: 'address', name: 'to', type: 'address' }, { internalType: 'uint256', name: 'tokenId', type: 'uint256' }], name: 'approve', outputs: [], stateMutability: 'nonpayable', type: 'function' },
        { inputs: [], name: 'nextTokenId', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
      ];

      let targetTokenId = 1n;
      try {
        const nextId = await publicClient.readContract({
          address: collectionAddr,
          abi: artworkAbi,
          functionName: 'nextTokenId',
        });
        targetTokenId = nextId;
      } catch {
        targetTokenId = 1n;
      }

      const mintTx = await walletClient.writeContract({
        address: collectionAddr,
        abi: artworkAbi,
        functionName: 'mint',
        args: [metadataUri],
      });
      setLastTxHash(mintTx);
      await publicClient.waitForTransactionReceipt({ hash: mintTx });

      setTxStep('Step 4/5: Approving AuctionHouse for escrow transfer...');
      const approveTx = await walletClient.writeContract({
        address: collectionAddr,
        abi: artworkAbi,
        functionName: 'approve',
        args: [deployment.contracts.AuctionHouse.address, targetTokenId],
      });
      setLastTxHash(approveTx);
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // 5. Create Lot on AuctionHouse
      setTxStep('Step 5/5: Listing artwork auction on-chain...');
      const now = BigInt(Math.floor(Date.now() / 1000));
      const durationSeconds = BigInt(Math.floor(parseFloat(dropDurationHours) * 3600));
      const minInc = parseEther(dropMinIncrement || '0.01');
      const buyNowPriceWei = dropBuyNow && parseFloat(dropBuyNow) > 0 ? parseEther(dropBuyNow) : 0n;

      const createLotTx = await walletClient.writeContract({
        address: deployment.contracts.AuctionHouse.address,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: buyNowPriceWei > 0n ? 'createLotWithBuyNow' : 'createLot',
        args: buyNowPriceWei > 0n
          ? [collectionAddr, targetTokenId, parseEther(dropReserve), minInc, now, now + durationSeconds, buyNowPriceWei]
          : [collectionAddr, targetTokenId, parseEther(dropReserve), minInc, now, now + durationSeconds],
      });
      setLastTxHash(createLotTx);
      await publicClient.waitForTransactionReceipt({ hash: createLotTx });

      setTxStep('Auction lot live! Indexing on-chain state...');
      await new Promise((r) => setTimeout(r, 1200));
      await loadLots();
      await updateAccountDetails();

      alert(`🎉 Drop created & artwork listed on-chain!\nToken ID: #${targetTokenId}\nReserve: ${dropReserve} ETH${dropBuyNow ? `\nBuy Now: ${dropBuyNow} ETH` : ''}`);
      setShowCreateDropModal(false);
      setDropTitle('');
      setDropDesc('');
      setDropBuyNow('');
      setDropImageFile(null);
      setImagePreviewUrl(null);
    } catch (err) {
      alert(`Drop creation failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Instant Buy Now (SuperRare-tier Instant Settlement)
  async function handleBuyNow(lot) {
    if (!lot.buyNowEth) return;
    if (!confirm(`Buy "${lot.title || 'Artwork'}" immediately for ${lot.buyNowEth} ETH? This will instantly settle the lot on-chain and transfer the 1/1 NFT to your wallet.`)) return;

    setTxPending(true);
    setLastTxHash('');
    setTxStep(`1/2: Purchasing 1/1 NFT for ${lot.buyNowEth} ETH...`);
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'buyNow',
        args: [BigInt(lot.lotId)],
        value: parseEther(lot.buyNowEth),
      });
      setLastTxHash(hash);
      setTxStep('2/2: Confirming instant settlement on-chain...');
      await publicClient.waitForTransactionReceipt({ hash });
      alert(`🎉 Congratulations! You have acquired "${lot.title || 'Artwork'}"! The 1/1 NFT has been transferred to your wallet.`);
      await loadLots();
      await updateAccountDetails();
      if (selectedLot?.id === lot.id) setSelectedLot(null);
    } catch (err) {
      alert(`Buy Now failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Place Bid
  async function handlePlaceBid(lot) {
    if (!bidInput || isNaN(parseFloat(bidInput))) {
      alert('Please enter a valid ETH bid amount.');
      return;
    }
    const currentHigh = parseFloat(lot.highestBidEth);
    const minIncrement = parseFloat(lot.minIncrementEth || '0.01');
    const minBid = currentHigh > 0 ? currentHigh + minIncrement : parseFloat(lot.reserveEth);

    if (parseFloat(bidInput) < minBid) {
      alert(`Minimum bid required is ${minBid.toFixed(4)} ETH.`);
      return;
    }

    setTxPending(true);
    setLastTxHash('');
    setTxStep('1/3: Signing and broadcasting bid transaction to Ethereum...');
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'placeBid',
        args: [BigInt(lot.lotId)],
        value: parseEther(bidInput),
      });
      setLastTxHash(hash);

      setTxStep('2/3: Waiting for on-chain block confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      setTxStep('3/3: Bid confirmed! Synchronizing marketplace state...');
      setBidInput('');
      await new Promise((r) => setTimeout(r, 1200));
      await loadLots();
      await updateAccountDetails();
    } catch (err) {
      alert(`Bid transaction failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Mint Soulbound Patron Edition
  async function handleMintPatron(lot) {
    if (!deployment?.contracts?.PatronEdition) return;
    setTxPending(true);
    setLastTxHash('');
    try {
      const mintPrice = await publicClient.readContract({
        address: deployment.contracts.PatronEdition.address,
        abi: deployment.contracts.PatronEdition.abi,
        functionName: 'mintPrice',
      });
      setTxStep(`1/2: Minting Soulbound Patron Edition (${formatEther(mintPrice)} ETH)...`);
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'mintPatronEdition',
        args: [BigInt(lot.lotId)],
        value: mintPrice,
      });
      setLastTxHash(hash);
      setTxStep('2/2: Confirming Patron NFT mint on-chain...');
      await publicClient.waitForTransactionReceipt({ hash });
      alert('✨ Soulbound Patron Edition token successfully minted to your wallet!');
      await updateAccountDetails();
      await loadLots();
    } catch (err) {
      alert(`Mint failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Withdraw Outbid Refund
  async function handleWithdrawRefund() {
    if (!deployment?.contracts?.AuctionHouse) return;
    setTxPending(true);
    setLastTxHash('');
    setTxStep('Withdrawing outbid ETH refund to wallet...');
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: deployment.contracts.AuctionHouse.address,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'withdrawRefund',
      });
      setLastTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      alert(`✔ Outbid ETH refund successfully withdrawn to ${activeAccount.address}!`);
      await updateAccountDetails();
    } catch (err) {
      alert(`Refund failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Settle Auction
  async function handleSettleLot(lot) {
    setTxPending(true);
    setLastTxHash('');
    setTxStep('Settling auction lot on-chain...');
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'settle',
        args: [BigInt(lot.lotId)],
      });
      setLastTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      alert('Auction settled! Artwork transferred and proceeds distributed.');
      await loadLots();
      await updateAccountDetails();
      if (selectedLot?.id === lot.id) setSelectedLot(null);
    } catch (err) {
      alert(`Settlement failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // Cancel Auction (Available only if no bids placed)
  async function handleCancelLot(lot) {
    if (!confirm('Are you sure you want to cancel this auction and reclaim your NFT?')) return;
    setTxPending(true);
    setLastTxHash('');
    setTxStep('Cancelling auction lot on-chain...');
    try {
      const walletClient = getWalletClient();
      const hash = await walletClient.writeContract({
        address: lot.auctionAddress,
        abi: deployment.contracts.AuctionHouse.abi,
        functionName: 'cancel',
        args: [BigInt(lot.lotId)],
      });
      setLastTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      alert('Auction cancelled. Artwork NFT returned to your wallet.');
      await loadLots();
      if (selectedLot?.id === lot.id) setSelectedLot(null);
    } catch (err) {
      alert(`Cancel failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Secondary Market Resale — list any owned NFT for auction
  // ────────────────────────────────────────────────────────────────────────────
  async function handleRelistForSale(e) {
    e.preventDefault();
    if (!relistNftAddress || !relistTokenId || !relistReserve) {
      alert('NFT contract address, Token ID, and reserve price are required.');
      return;
    }
    if (!deployment?.contracts?.AuctionHouse) {
      alert('AuctionHouse contract not found. Deploy contracts first.');
      return;
    }
    setTxPending(true);
    setLastTxHash('');
    try {
      const authToken = await getOrInitSession(activeAccount);
      void authToken; // used to verify session is live

      const walletClient = getWalletClient();
      const nftAddr = relistNftAddress.trim();
      const tokenId = BigInt(relistTokenId.trim());
      const auctionAddr = deployment.contracts.AuctionHouse.address;
      const auctionAbi = deployment.contracts.AuctionHouse.abi;

      // Step 1: Approve AuctionHouse to escrow the token
      setTxStep('1/3: Approving AuctionHouse as NFT escrow operator...');
      const minimalNftAbi = [
        { inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], name: 'approve', outputs: [], stateMutability: 'nonpayable', type: 'function' },
      ];
      const approveTx = await walletClient.writeContract({
        address: nftAddr,
        abi: minimalNftAbi,
        functionName: 'approve',
        args: [auctionAddr, tokenId],
      });
      setLastTxHash(approveTx);
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // Step 2: Create the auction lot
      setTxStep('2/3: Creating secondary market auction lot on-chain...');
      const now = BigInt(Math.floor(Date.now() / 1000));
      const durationSec = BigInt(Math.floor(parseFloat(relistDuration) * 3600));
      const buyNowWei = relistBuyNow && parseFloat(relistBuyNow) > 0 ? parseEther(relistBuyNow) : 0n;
      const minInc = parseEther(relistMinIncrement || '0.01');

      const createTx = await walletClient.writeContract({
        address: auctionAddr,
        abi: auctionAbi,
        functionName: buyNowWei > 0n ? 'createLotWithBuyNow' : 'createLot',
        args: buyNowWei > 0n
          ? [nftAddr, tokenId, parseEther(relistReserve), minInc, now, now + durationSec, buyNowWei]
          : [nftAddr, tokenId, parseEther(relistReserve), minInc, now, now + durationSec],
      });
      setLastTxHash(createTx);
      setTxStep('3/3: Confirming on-chain and indexing...');
      await publicClient.waitForTransactionReceipt({ hash: createTx });

      await new Promise((r) => setTimeout(r, 1500));
      await loadLots();
      await updateAccountDetails();
      alert(`✓ NFT #${relistTokenId} listed for secondary sale!\nReserve: ${relistReserve} ETH${relistBuyNow ? ` • Buy Now: ${relistBuyNow} ETH` : ''}`);
      setShowRelistModal(false);
      setRelistNftAddress('');
      setRelistTokenId('');
      setRelistBuyNow('');
    } catch (err) {
      alert(`Relist failed: ${err.shortMessage || err.message}`);
    } finally {
      setTxPending(false);
      setTxStep('');
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Artist Application Form
  // ────────────────────────────────────────────────────────────────────────────
  async function handleArtistApply(e) {
    e.preventDefault();
    if (!applyHandle || !applyDisplayName) return;
    setApplyPending(true);
    try {
      const authToken = await getOrInitSession(activeAccount);
      const res = await fetch(`${apiBase}/api/artists/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ handle: applyHandle, displayName: applyDisplayName, bio: applyBio }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message || 'Application failed.');
      alert(`✓ Artist application submitted!\nHandle: @${applyHandle}\nStatus: Pending curation review.`);
      setShowArtistApplyModal(false);
      setApplyHandle('');
      setApplyDisplayName('');
      setApplyBio('');
    } catch (err) {
      alert(`Application failed: ${err.message}`);
    } finally {
      setApplyPending(false);
    }
  }

  // Filter & Sort
  const counts = useMemo(() => {
    const total = lotsState.lots.length + vouchers.filter(v => !v.isRedeemed).length;
    const live = lotsState.lots.filter(l => (new Date(l.endTime).getTime() > currentTime) && l.status === 'active').length;
    const buynow = lotsState.lots.filter(l => l.buyNowEth && l.status === 'active' && new Date(l.endTime).getTime() > currentTime).length;
    const settled = lotsState.lots.filter(l => (new Date(l.endTime).getTime() <= currentTime) || l.status === 'settled').length;
    const lazy = vouchers.filter(v => !v.isRedeemed).length;
    return { total, live, buynow, settled, lazy };
  }, [lotsState.lots, vouchers, currentTime]);

  const filteredVouchers = useMemo(() => {
    return vouchers.filter((v) => {
      if (v.isRedeemed) return false;
      const matchesSearch =
        (v.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (v.artistName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.artist.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch;
    });
  }, [vouchers, searchQuery]);

  const filteredLots = useMemo(() => {
    return lotsState.lots.filter((lot) => {
      const matchesSearch =
        (lot.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (lot.artistName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        lot.creator.toLowerCase().includes(searchQuery.toLowerCase());

      const isEnded = new Date(lot.endTime).getTime() <= currentTime || lot.status === 'settled';
      if (statusFilter === 'live') return matchesSearch && !isEnded && lot.status === 'active';
      if (statusFilter === 'buynow') return matchesSearch && lot.buyNowEth && lot.status === 'active' && !isEnded;
      if (statusFilter === 'settled') return matchesSearch && (isEnded || lot.status === 'settled');
      if (statusFilter === 'lazy') return false;
      return matchesSearch;
    }).sort((a, b) => {
      if (sortBy === 'highest_bid') return parseFloat(b.highestBidEth) - parseFloat(a.highestBidEth);
      if (sortBy === 'ending_soon') return new Date(a.endTime).getTime() - new Date(b.endTime).getTime();
      return b.id.localeCompare(a.id); // Newest
    });
  }, [lotsState.lots, searchQuery, statusFilter, sortBy, currentTime]);

  return (
    <div className="app">
      {/* Live On-Chain Activity Ticker */}
      <div className="activity-ticker">
        <span className="ticker-title">⚡ ON-CHAIN MARKET FEED</span>
        <div className="ticker-item">
          <span>Network:</span>
          <b className="network-pill" onClick={() => setShowNetworkModal(true)}>
            {activeNetwork.name} ({activeNetwork.id}) ▾
          </b>
        </div>
        <div className="ticker-item">
          <span>AuctionHouse:</span>
          <code>{deployment?.contracts?.AuctionHouse?.address ? `${deployment.contracts.AuctionHouse.address.slice(0, 6)}…${deployment.contracts.AuctionHouse.address.slice(-4)}` : 'Connecting…'}</code>
        </div>
        <div className="ticker-item">
          <span>PatronEdition:</span>
          <code>{deployment?.contracts?.PatronEdition?.address ? `${deployment.contracts.PatronEdition.address.slice(0, 6)}…` : 'Active'}</code>
        </div>
        <div className="ticker-item">
          <span>Indexed Lots:</span>
          <b>{lotsState.lots.length} Verified</b>
        </div>
      </div>

      {/* Header */}
      <header>
        <div className="brand" onClick={() => setActiveView('market')}>
          <span className="mark">✦</span> patronage
          <span className="chain-badge">{activeNetwork.shortName}</span>
        </div>

        <nav>
          <button className={activeView === 'market' ? 'active' : ''} onClick={() => setActiveView('market')}>
            Discover
          </button>
          <button onClick={() => { setShowProfileModal(true); void loadProfile(); }}>
            Collector Profile
          </button>
          <button onClick={() => setShowArtistApplyModal(true)}>
            Apply as Artist
          </button>
          <button className="create-drop-tab-btn" onClick={() => setShowCreateDropModal(true)}>
            + Create Drop
          </button>
          <button className="relist-nav-btn" onClick={() => setShowRelistModal(true)} title="List any NFT you own for secondary market auction">
            ↺ Relist NFT
          </button>
        </nav>

        <div className="header-actions">
          {/* Network Switcher Pill */}
          <button className="network-btn" onClick={() => setShowNetworkModal(true)}>
            <span className={`dot ${activeNetwork.testnet ? 'testnet' : 'online'}`} />
            {activeNetwork.shortName}
          </button>

          {/* Notification Bell */}
          {session && (
            <button
              className="notif-btn"
              onClick={() => {
                setShowNotifications(!showNotifications);
                setUnreadCount(0);
                if (notifications.length > 0) lastSeenNotifRef.current = notifications[0].createdAt;
              }}
              title="Notifications"
              id="notif-bell-btn"
            >
              🔔
              {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
          )}

          {/* Refundable Balance Alert */}
          {parseFloat(refundableEth) > 0 && (
            <button className="refund-btn" onClick={handleWithdrawRefund} title="Claim outbid funds">
              Withdraw {refundableEth} ETH
            </button>
          )}

          {/* Wallet Button */}
          <button className="connect" onClick={() => setShowWalletModal(true)}>
            <span className="dot online" />
            {activeAccount.address.slice(0, 6)}…{activeAccount.address.slice(-4)} ({accountBalance} ETH)
          </button>
        </div>
      </header>

      {/* Notifications Dropdown */}
      {showNotifications && (
        <div className="notif-dropdown" id="notif-dropdown">
          <div className="notif-header">
            <b>Notifications</b>
            <button className="notif-close" onClick={() => setShowNotifications(false)}>×</button>
          </div>
          {notifications.length === 0 ? (
            <p className="notif-empty">No notifications yet. Start bidding!</p>
          ) : (
            <ul className="notif-list">
              {notifications.slice(0, 15).map((n) => {
                const p = n.payload || {};
                const icons = { outbid: '🔴', bid_placed: '🟢', lot_won: '🏆', lot_settled_seller: '💰', buy_now_executed: '⚡' };
                const labels = {
                  outbid: `You were outbid on “${p.title || 'Lot'}”. New bid: ${p.newBidEth} ETH`,
                  bid_placed: `Your bid of ${p.amountEth} ETH on “${p.title || 'Lot'}” confirmed.`,
                  lot_won: `🏆 You won “${p.title || 'Lot'}” for ${p.amountEth} ETH!`,
                  lot_settled_seller: p.soldTo ? `Your “${p.title}” sold for ${p.amountEth} ETH.` : `“${p.title}” auction ended with no bids.`,
                  buy_now_executed: `“${p.title || 'Lot'}” purchased instantly for ${p.amountEth} ETH.`,
                };
                return (
                  <li key={n.id} className="notif-item">
                    <span className="notif-icon">{icons[n.type] || 'ℹ️'}</span>
                    <div>
                      <p className="notif-msg">{labels[n.type] || n.type}</p>
                      <small className="notif-time">{new Date(n.createdAt).toLocaleString()}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <main>
        {/* Hero Section */}
        <section className="hero">
          <div>
            <p className="eyebrow">SINGULAR 1/1 ON-CHAIN ARTWORK</p>
            <h1>Art with a pulse.</h1>
            <p className="lede">
              Discover authentic 1/1 digital masterpieces verified directly on Ethereum.
              Bid for provenance ownership, or mint a Soulbound Patron Edition to permanently sponsor artists.
            </p>
            <div className="hero-actions">
              <button className="primary" onClick={() => document.getElementById('market')?.scrollIntoView({ behavior: 'smooth' })}>
                Explore current drops <span>↗</span>
              </button>
              <button className="text-btn" onClick={() => setShowCreateDropModal(true)}>
                + Mint & list 1/1 artwork <span>→</span>
              </button>
            </div>
          </div>

          <div className="hero-art">
            <div className="orbit orbit-a" />
            <div className="orbit orbit-b" />
            <div className="hero-piece">
              <span>1 / 1<br /><i>on-chain</i></span>
            </div>
            <div className="art-caption">
              <span>ACTIVE NETWORK</span>
              <b>{activeNetwork.name}</b>
              <small>Chain ID: {activeNetwork.id} • Non-custodial</small>
            </div>
          </div>
        </section>

        {/* Marketplace Section */}
        <section id="market" className="market">
          <div className="section-head">
            <div>
              <p className="eyebrow">THE MARKETPLACE</p>
              <h2>Live Artwork Auctions</h2>
            </div>
            <div className="filter-bar">
              <input
                type="text"
                className="search-input"
                placeholder="Search title, artist, wallet address..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All Statuses</option>
                <option value="live">Live Auctions</option>
                <option value="buynow">Buy Now Available</option>
                <option value="settled">Settled Archive</option>
              </select>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="newest">Newest Listed</option>
                <option value="highest_bid">Highest Bid</option>
                <option value="ending_soon">Ending Soon</option>
              </select>
            </div>
          </div>

          <div className="filter-pill-row">
            <button
              className={`filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All Artworks ({counts.total})
            </button>
            <button
              className={`filter-pill ${statusFilter === 'live' ? 'active' : ''}`}
              onClick={() => setStatusFilter('live')}
            >
              🔴 Live Auctions ({counts.live})
            </button>
            <button
              className={`filter-pill ${statusFilter === 'buynow' ? 'active' : ''}`}
              onClick={() => setStatusFilter('buynow')}
            >
              ⚡ Buy Now Available ({counts.buynow})
            </button>
            <button
              className={`filter-pill ${statusFilter === 'settled' ? 'active' : ''}`}
              onClick={() => setStatusFilter('settled')}
            >
              ✔ Settled Archive ({counts.settled})
            </button>
            <button
              className={`filter-pill ${statusFilter === 'lazy' ? 'active' : ''}`}
              onClick={() => setStatusFilter('lazy')}
            >
              ⚡ Gasless Lazy Mints ({counts.lazy})
            </button>
          </div>

          {lotsState.status === 'loading' && (
            <div className="data-state">
              <p className="eyebrow">READING INDEXER</p>
              <h3>Loading verified auctions…</h3>
              <p>Fetching on-chain lot events from indexer database.</p>
            </div>
          )}

          {lotsState.status === 'error' && (
            <div className="data-state error-state">
              <p className="eyebrow">DATABASE OFFLINE</p>
              <h3>Marketplace service is unavailable.</h3>
              <p>{lotsState.error}</p>
              <button className="outline dark" onClick={() => void loadLots()}>Retry <span>↗</span></button>
            </div>
          )}

          {lotsState.status === 'ready' && filteredLots.length === 0 && ((statusFilter !== 'all' && statusFilter !== 'lazy') || filteredVouchers.length === 0) && (
            <div className="data-state">
              <p className="eyebrow">NO ARTWORKS MATCHING FILTER</p>
              <h3>No artwork drops match your criteria.</h3>
              <p>Be the first artist to mint or create a gasless drop on {activeNetwork.name}.</p>
              <button className="primary" onClick={() => setShowCreateDropModal(true)}>
                + Create First Drop ↗
              </button>
            </div>
          )}

          {lotsState.status === 'ready' && (filteredLots.length > 0 || ((statusFilter === 'all' || statusFilter === 'lazy') && filteredVouchers.length > 0)) && (
            <div className="grid">
              {filteredLots.map((lot) => {
                const isEnded = new Date(lot.endTime).getTime() <= currentTime || lot.status === 'settled';
                const timeStr = isEnded ? 'Ended' : formatTimeRemaining(lot.endTime);

                return (
                  <article className="card" key={`${lot.chainId}-${lot.auctionAddress}-${lot.lotId}`} onClick={() => setSelectedLot(lot)}>
                    <div
                      className="art"
                      style={{ backgroundImage: lot.imageUrl ? `url(${lot.imageUrl})` : 'none', backgroundColor: '#18181c' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightboxImage(lot.imageUrl || null);
                        setLightboxTitle(lot.title || 'Untitled Artwork');
                        setLightboxArtist(lot.artistName || 'Artist');
                        setIsZoomed(false);
                      }}
                      title="Click artwork to open Museum Cinema Lightbox"
                    >
                      <span className="edition">1 / 1</span>
                      {lot.buyNowEth && lot.status === 'active' && !isEnded && (
                        <span className="buynow-badge">⚡ BUY NOW {lot.buyNowEth} ETH</span>
                      )}
                      <span className={`status-pill ${lot.status}`}>{lot.status.toUpperCase()}</span>
                      <span className="arrow" onClick={(e) => { e.stopPropagation(); setSelectedLot(lot); }}>↗</span>
                    </div>
                    <div className="card-body">
                      <div className="work-title">
                        <div>
                          <h3>{lot.title || 'Untitled Artwork'}</h3>
                          <p>
                            <span
                              style={{ cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setViewingArtist({
                                  name: lot.artistName || 'Artist',
                                  handle: lot.artistHandle || '',
                                  address: lot.creator,
                                });
                              }}
                              title="View artist profile and provenance"
                            >
                              {lot.artistName || 'Artist'} {lot.artistHandle ? <span>@{lot.artistHandle}</span> : null}
                            </span>
                          </p>
                        </div>
                      </div>
                      <div className="card-meta">
                        <div>
                          <small>{lot.buyNowEth && lot.status === 'active' && !isEnded ? 'CURRENT BID / BUY NOW' : 'CURRENT BID'}</small>
                          <b>{lot.highestBidEth} ETH <span className="price-usd">({formatUsd(lot.highestBidEth)})</span></b>
                          <em>{lot.highestBidEth === '0' ? `Reserve ${lot.reserveEth} ETH (${formatUsd(lot.reserveEth)})` : `${lot.bidCount} bids placed`}</em>
                        </div>
                        <div className="ending">
                          <small>TIME REMAINING</small>
                          <b className={!isEnded ? 'countdown-pulse' : ''}>{timeStr}</b>
                          {!isEnded && lot.status === 'active' && (
                            <span className="anti-snipe-badge" title="Bids in final 15 minutes extend the auction by 15 minutes on-chain">
                              🛡️ 15m Anti-Snipe
                            </span>
                          )}
                          <em>{isEnded ? 'Auction Concluded' : 'Live English Auction'}</em>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}

              {(statusFilter === 'all' || statusFilter === 'lazy') && filteredVouchers.map((voucher) => (
                <article className="card lazy-card" key={`voucher-${voucher.id}`} onClick={() => setSelectedVoucher(voucher)}>
                  <div
                    className="art"
                    style={{ backgroundImage: voucher.imageUrl ? `url(${voucher.imageUrl})` : 'none', backgroundColor: '#18181c' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxImage(voucher.imageUrl || null);
                      setLightboxTitle(voucher.title || 'Untitled Artwork');
                      setLightboxArtist(voucher.artistName || 'Artist');
                      setIsZoomed(false);
                    }}
                    title="Click artwork to open Museum Cinema Lightbox"
                  >
                    <span className="edition">1 / 1 • Gasless</span>
                    <span className="buynow-badge" style={{ background: '#7c3aed', color: '#fff' }}>⚡ LAZY MINT</span>
                    <span className="status-pill active">AVAILABLE</span>
                    <span className="arrow" onClick={(e) => { e.stopPropagation(); setSelectedVoucher(voucher); }}>↗</span>
                  </div>
                  <div className="card-body">
                    <div className="work-title">
                      <div>
                        <h3>{voucher.title || 'Untitled Artwork'}</h3>
                        <p>
                          <span
                            style={{ cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setViewingArtist({
                                name: voucher.artistName || 'Artist',
                                handle: '',
                                address: voucher.artist,
                              });
                            }}
                            title="View artist profile"
                          >
                            {voucher.artistName || 'Artist'}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="card-meta">
                      <div>
                        <small>MINT & CLAIM PRICE</small>
                        <b>{voucher.minPriceEth} ETH <span className="price-usd">({formatUsd(voucher.minPriceEth)})</span></b>
                        <em style={{ color: '#8b5cf6' }}>Gasless EIP-712 Voucher</em>
                      </div>
                      <div className="ending">
                        <small>STATUS</small>
                        <b style={{ color: '#10b981' }}>Ready to Mint</b>
                        <em>Collector Mints On-Demand</em>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer>
        <div className="brand"><span className="mark">✦</span> patronage</div>
        <span>Zero-cloud, non-custodial 1/1 digital art on Ethereum.</span>
        <div>
          {activeNetwork.explorer && (
            <a href={activeNetwork.explorer} target="_blank" rel="noreferrer">
              Etherscan ({activeNetwork.shortName}) ↗
            </a>
          )}
          <a onClick={() => setShowNetworkModal(true)}>Switch Network</a>
          <a onClick={() => setShowCreateDropModal(true)}>Artist Studio</a>
        </div>
      </footer>

      {/* Lot Detail Modal */}
      {selectedLot && (() => {
        const isEnded = new Date(selectedLot.endTime).getTime() <= currentTime || selectedLot.status === 'settled';
        const timeStr = isEnded ? 'Ended' : formatTimeRemaining(selectedLot.endTime);
        const isSeller = activeAccount.address.toLowerCase() === selectedLot.creator.toLowerCase();
        const hasNoBids = selectedLot.highestBidEth === '0';

        return (
          <div className="modal-bg" onClick={() => setSelectedLot(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <button className="close" aria-label="Close" onClick={() => setSelectedLot(null)}>×</button>
              <div
                className="modal-art"
                style={{ backgroundImage: selectedLot.imageUrl ? `url(${selectedLot.imageUrl})` : 'none', backgroundColor: '#111', cursor: 'zoom-in' }}
                onClick={() => {
                  setLightboxImage(selectedLot.imageUrl || null);
                  setLightboxTitle(selectedLot.title || 'Untitled artwork');
                  setLightboxArtist(selectedLot.artistName || 'Artist');
                  setIsZoomed(false);
                }}
                title="Click to view in Cinema Lightbox"
              >
                <span>1 / 1 • Cinema View 🔍</span>
              </div>
              <div className="modal-info">
                <p className="eyebrow">{selectedLot.status.toUpperCase()} AUCTION • LOT #{selectedLot.lotId}</p>
                <h2>{selectedLot.title || 'Untitled artwork'}</h2>
                <p
                  className="artist-name"
                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => setViewingArtist({
                    name: selectedLot.artistName || 'Artist',
                    handle: selectedLot.artistHandle || '',
                    address: selectedLot.creator,
                  })}
                  title="View creator profile"
                >
                  {selectedLot.artistName || 'Artist'} {selectedLot.artistHandle ? <span>@{selectedLot.artistHandle}</span> : null}
                </p>

                {/* Modal Tabs */}
                <div className="modal-tabs">
                  <button
                    className={`tab-btn ${modalTab === 'provenance' ? 'active' : ''}`}
                    onClick={() => setModalTab('provenance')}
                  >
                    Provenance & Specs
                  </button>
                  <button
                    className={`tab-btn ${modalTab === 'bids' ? 'active' : ''}`}
                    onClick={() => setModalTab('bids')}
                  >
                    Bid Ledger ({selectedLot.bids?.length || 0})
                  </button>
                  <button
                    className={`tab-btn ${modalTab === 'offers' ? 'active' : ''}`}
                    onClick={() => setModalTab('offers')}
                  >
                    Offers ({offers.filter((o) => o.status === 'active' || o.status === 'countered').length})
                  </button>
                </div>

                {modalTab === 'provenance' ? (
                  <>
                    {/* Contract Specifications */}
                    <div className="contract-details-box">
                      <small>ON-CHAIN VERIFICATION & EIP-2981 SPECIFICATIONS</small>
                      <div className="spec-row">
                        <span>Token ID:</span>
                        <b>#{selectedLot.tokenId}</b>
                      </div>
                      <div className="spec-row">
                        <span>NFT Contract:</span>
                        <code onClick={() => navigator.clipboard.writeText(selectedLot.nftAddress)} title="Click to copy">
                          {selectedLot.nftAddress.slice(0, 8)}…{selectedLot.nftAddress.slice(-6)}
                        </code>
                      </div>
                      <div className="spec-row">
                        <span>Artist / Royalty Receiver:</span>
                        <code title={selectedLot.creator}>
                          <AddrDisplay address={selectedLot.creator} explorer={activeNetwork.explorer} />
                        </code>
                      </div>
                      <div className="spec-row">
                        <span>Highest Bidder:</span>
                        <code title={selectedLot.highestBidder || '—'}>
                          {selectedLot.highestBidder
                            ? <AddrDisplay address={selectedLot.highestBidder} explorer={activeNetwork.explorer} />
                            : <span style={{color:'#aaa'}}>No bids yet</span>}
                        </code>
                      </div>
                      <div className="spec-row">
                        <span>Secondary Royalty:</span>
                        <b>5.0% (EIP-2981 Standard)</b>
                      </div>
                      <div className="spec-row">
                        <span>Anti-Sniping Protection:</span>
                        <b style={{ color: '#b7791f' }}>15 Min Auto-Extension</b>
                      </div>
                      {selectedLot.buyNowEth && (
                        <div className="spec-row">
                          <span>Instant Settle (Buy Now):</span>
                          <b style={{ color: '#2b6cb0' }}>{selectedLot.buyNowEth} ETH ({formatUsd(selectedLot.buyNowEth)})</b>
                        </div>
                      )}
                      {activeNetwork.explorer && (
                        <div className="spec-row explorer-link-row">
                          <span>Explorer:</span>
                          <a href={`${activeNetwork.explorer}/address/${selectedLot.nftAddress}`} target="_blank" rel="noreferrer">
                            View NFT Contract on Etherscan ↗
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Provenance Timeline */}
                    <div className="provenance-timeline">
                      <div className="timeline-item mint">
                        <div className="timeline-header">
                          <span className="timeline-title">Minted 1/1 ERC-721 Token</span>
                          <span className="timeline-time">On-Chain</span>
                        </div>
                        <div className="timeline-desc">
                          Token #{selectedLot.tokenId} verified on contract {selectedLot.nftAddress.slice(0, 6)}…{selectedLot.nftAddress.slice(-4)} with non-custodial metadata.
                        </div>
                      </div>

                      <div className="timeline-item list">
                        <div className="timeline-header">
                          <span className="timeline-title">Listed on AuctionHouse</span>
                          <span className="timeline-time">Lot #{selectedLot.lotId}</span>
                        </div>
                        <div className="timeline-desc">
                          Reserve: {selectedLot.reserveEth} ETH • 5% EIP-2981 Royalty
                          {selectedLot.buyNowEth ? ` • ⚡ Buy Now Price: ${selectedLot.buyNowEth} ETH` : ''}
                        </div>
                      </div>

                      {selectedLot.bids && selectedLot.bids.slice().reverse().map((b, idx) => (
                        <div className="timeline-item bid" key={b.id || idx}>
                          <div className="timeline-header">
                            <span className="timeline-title">Bid Placed: {b.amountEth} ETH</span>
                            <span className="timeline-time">
                              <AddrDisplay address={b.bidder} explorer={activeNetwork.explorer} />
                            </span>
                          </div>
                          <div className="timeline-desc">
                            Recorded on block #{b.blockNumber || 'verified'}. Outbid funds held in pull-over-push refund vault.
                          </div>
                        </div>
                      ))}

                      {selectedLot.status === 'settled' && (
                        <div className="timeline-item settled">
                          <div className="timeline-header">
                            <span className="timeline-title">Auction Settled & Transferred</span>
                            <span className="timeline-time">Permanent</span>
                          </div>
                          <div className="timeline-desc">
                            {selectedLot.highestBidder
                              ? <>Artwork transferred to <AddrDisplay address={selectedLot.highestBidder} explorer={activeNetwork.explorer} />. Proceeds disbursed on-chain.</>  
                              : 'Auction ended with no bids meeting reserve. NFT returned to artist.'}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : modalTab === 'bids' ? (
                  /* Bid History Ledger */
                  selectedLot.bids && selectedLot.bids.length > 0 ? (
                    <div className="bids-history" style={{ borderTop: 'none', paddingTop: 0 }}>
                      <h4>Bid Ledger ({selectedLot.bids.length} bids)</h4>
                      <ul>
                        {selectedLot.bids.map((b) => (
                          <li key={b.id}>
                            <span><AddrDisplay address={b.bidder} explorer={activeNetwork.explorer} /></span>
                            <b>{b.amountEth} ETH</b>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="no-bids-text">No bids placed yet. Place the reserve bid to activate auction countdown.</p>
                  )
                ) : (
                  /* Offers & Counter-Offers Ledger */
                  <div className="offers-ledger-container">
                    <h4>On-Chain Escrowed Offers ({offers.length})</h4>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                      Offers lock ETH directly into on-chain escrow. Artists can accept or counter below reserve.
                    </p>

                    {offers.length > 0 ? (
                      <div className="offers-list">
                        {offers.map((off) => {
                          const isOfferBuyer = off.buyer?.toLowerCase() === activeAccount.address.toLowerCase();
                          return (
                            <div key={off.id} className="offer-card">
                              <div className="offer-card-top">
                                <span className="offer-buyer-addr">
                                  <AddrDisplay address={off.buyer} explorer={activeNetwork.explorer} />
                                  {isOfferBuyer && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--accent-gold)' }}>(You)</span>}
                                </span>
                                <span className="offer-amount-eth">{off.amountEth} ETH</span>
                              </div>
                              <div className="offer-card-mid">
                                <span>Status: <b style={{ textTransform: 'uppercase', color: off.status === 'active' ? 'var(--status-emerald)' : 'var(--accent-coral)' }}>{off.status}</b></span>
                                <span>{formatUsd(off.amountEth)}</span>
                              </div>

                              {off.counterAmountEth && (
                                <div className="counter-offer-banner">
                                  <span>Artist Counter-Offer:</span>
                                  <b>{off.counterAmountEth} ETH ({formatUsd(off.counterAmountEth)})</b>
                                </div>
                              )}

                              {/* Action buttons */}
                              <div className="offer-actions-bar">
                                {isSeller && off.status === 'active' && hasNoBids && (
                                  <>
                                    <button
                                      className="offer-btn-accept"
                                      disabled={txPending}
                                      onClick={() => handleAcceptOffer(selectedLot, off)}
                                    >
                                      Accept Offer ↗
                                    </button>
                                    <button
                                      className="offer-btn-counter"
                                      disabled={txPending}
                                      onClick={() => handleCounterOffer(selectedLot, off)}
                                    >
                                      Counter-Offer ↺
                                    </button>
                                  </>
                                )}
                                {isOfferBuyer && (off.status === 'active' || off.status === 'countered') && (
                                  <button
                                    className="offer-btn-cancel"
                                    disabled={txPending}
                                    onClick={() => handleCancelOffer(selectedLot)}
                                  >
                                    Cancel & Refund
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="no-bids-text" style={{ padding: '16px 0' }}>No on-chain offers submitted for this piece yet.</p>
                    )}

                    {/* Make Offer Input for collectors */}
                    {!isSeller && (
                      <div className="offer-form-box">
                        <label>Submit Escrowed Offer (ETH)</label>
                        <div className="offer-input-row">
                          <input
                            type="number"
                            step="0.001"
                            placeholder="e.g. 0.25 (locks in contract escrow)"
                            value={offerInput}
                            onChange={(e) => setOfferInput(e.target.value)}
                          />
                          <button
                            className="primary"
                            disabled={txPending || !offerInput}
                            onClick={() => handleMakeOffer(selectedLot)}
                          >
                            {txPending ? 'Submitting…' : 'Make Offer ↗'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Bidding Stats */}
                <div className="bid-box">
                  <div>
                    <small>CURRENT HIGHEST BID</small>
                    <b>{selectedLot.highestBidEth} ETH <span className="price-usd">({formatUsd(selectedLot.highestBidEth)})</span></b>
                    <em>{selectedLot.highestBidEth === '0' ? `Reserve: ${selectedLot.reserveEth} ETH (${formatUsd(selectedLot.reserveEth)})` : `Bidder: ${selectedLot.highestBidder?.slice(0, 6)}…`}</em>
                  </div>
                  <div>
                    <small>TIME REMAINING</small>
                    <b className={!isEnded ? 'countdown-pulse' : ''}>{timeStr}</b>
                    {!isEnded && selectedLot.status === 'active' && (
                      <span className="anti-snipe-badge" style={{ marginTop: '3px' }}>
                        🛡️ 15m Anti-Snipe Active
                      </span>
                    )}
                  </div>
                </div>

                {/* Auction Actions */}
                {!isEnded ? (
                  <div className="bid-action-group">
                    {/* Buy Now Button if configured */}
                    {selectedLot.buyNowEth && selectedLot.status === 'active' && (
                      <button
                        className="buy-now-btn"
                        disabled={txPending}
                        onClick={() => handleBuyNow(selectedLot)}
                      >
                        ⚡ Buy Now for {selectedLot.buyNowEth} ETH ({formatUsd(selectedLot.buyNowEth)}) (Instant Settle)
                      </button>
                    )}

                    <div className="input-with-button" style={{ marginTop: selectedLot.buyNowEth ? '10px' : '0' }}>
                      <input
                        type="number"
                        step="0.001"
                        placeholder={`Min ${(parseFloat(selectedLot.highestBidEth) > 0 ? parseFloat(selectedLot.highestBidEth) + parseFloat(selectedLot.minIncrementEth || '0.01') : parseFloat(selectedLot.reserveEth)).toFixed(4)} ETH`}
                        value={bidInput}
                        onChange={(e) => setBidInput(e.target.value)}
                      />
                      <button className="primary" disabled={txPending} onClick={() => handlePlaceBid(selectedLot)}>
                        {txPending ? 'Broadcasting…' : 'Place Bid ↗'}
                      </button>
                    </div>

                    <button className="patron-link" disabled={txPending} onClick={() => handleMintPatron(selectedLot)}>
                      ✦ Mint Soulbound Patron Edition (fixed price)
                    </button>

                    {/* Seller Lot Cancellation option if no bids */}
                    {isSeller && hasNoBids && selectedLot.status === 'active' && (
                      <button className="cancel-lot-btn" disabled={txPending} onClick={() => handleCancelLot(selectedLot)}>
                        Cancel Auction & Reclaim NFT
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="settle-action-group">
                    {selectedLot.status !== 'settled' ? (
                      <button className="primary wide" disabled={txPending} onClick={() => handleSettleLot(selectedLot)}>
                        {txPending ? 'Settling…' : 'Settle Auction Lot on Ethereum ↗'}
                      </button>
                    ) : (
                      <>
                        <div className="settled-notice">
                          ✔ This auction has been settled on-chain. Artwork transferred to winning collector.
                        </div>
                        {/* Collector: relist the won NFT */}
                        {selectedLot.highestBidder?.toLowerCase() === activeAccount.address.toLowerCase() && (
                          <button
                            className="relist-btn"
                            style={{ marginTop: 10 }}
                            onClick={() => {
                              setRelistNftAddress(selectedLot.nftAddress);
                              setRelistTokenId(selectedLot.tokenId);
                              setRelistPrefillTitle(selectedLot.title || '');
                              setShowRelistModal(true);
                              setSelectedLot(null);
                            }}
                          >
                            ↺ List this NFT for Secondary Sale
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Network Switcher Modal */}
      {showNetworkModal && (
        <div className="modal-bg" onClick={() => setShowNetworkModal(false)}>
          <div className="modal wallet-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowNetworkModal(false)}>×</button>
            <p className="eyebrow">SELECT BLOCKCHAIN NETWORK</p>
            <h2>Switch Network</h2>
            <p className="subtext">Select an Ethereum network for auctions and contract interactions.</p>

            <div className="account-list">
              {Object.values(NETWORKS).map((net) => (
                <div
                  key={net.id}
                  className={`account-card ${activeChainId === net.id ? 'selected' : ''}`}
                  onClick={() => switchNetwork(net.id)}
                >
                  <div className="acc-info">
                    <b>{net.name} {activeChainId === net.id ? '✔' : ''}</b>
                    <small>Chain ID: {net.id} • {net.testnet ? 'Testnet' : 'Mainnet'}</small>
                  </div>
                  <span className="acc-role">{net.currency}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Wallet Selector Modal */}
      {showWalletModal && (
        <div className="modal-bg" onClick={() => setShowWalletModal(false)}>
          <div className="modal wallet-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <button className="close" onClick={() => setShowWalletModal(false)}>×</button>
            <p className="eyebrow">MULTI-WALLET CONNECTION</p>
            <h2>Connect Ethereum Signer</h2>
            <p className="subtext">Select your preferred Web3 provider or developer account.</p>

            <div className="account-list">
              {/* MetaMask / Injected Extension */}
              <div className="wallet-card-custom" onClick={() => connectWalletType('injected')}>
                <div className="wallet-card-left">
                  <div className="wallet-brand-icon">🦊</div>
                  <div className="wallet-brand-meta">
                    <b>MetaMask / Injected</b>
                    <small>{typeof window !== 'undefined' && window.ethereum?.isMetaMask ? 'Detected & Ready' : 'Browser Web3 Provider'}</small>
                  </div>
                </div>
                <span className={`wallet-badge-status ${typeof window !== 'undefined' && window.ethereum?.isMetaMask ? 'ready' : ''}`}>
                  {typeof window !== 'undefined' && window.ethereum?.isMetaMask ? 'Detected' : 'Standard'}
                </span>
              </div>

              {/* Coinbase Wallet */}
              <div className="wallet-card-custom" onClick={() => connectWalletType('coinbase')}>
                <div className="wallet-card-left">
                  <div className="wallet-brand-icon">🔵</div>
                  <div className="wallet-brand-meta">
                    <b>Coinbase Wallet</b>
                    <small>{typeof window !== 'undefined' && (window.coinbaseWalletExtension || window.ethereum?.isCoinbaseWallet) ? 'Extension Ready' : 'Extension & Mobile App'}</small>
                  </div>
                </div>
                <span className={`wallet-badge-status ${typeof window !== 'undefined' && (window.coinbaseWalletExtension || window.ethereum?.isCoinbaseWallet) ? 'ready' : ''}`}>
                  Coinbase
                </span>
              </div>

              {/* WalletConnect v2 */}
              <div className="wallet-card-custom" onClick={() => connectWalletType('walletconnect')}>
                <div className="wallet-card-left">
                  <div className="wallet-brand-icon">🔗</div>
                  <div className="wallet-brand-meta">
                    <b>WalletConnect v2</b>
                    <small>Pair with Rainbow, Trust, Ledger & 100+ Mobile Apps</small>
                  </div>
                </div>
                <span className="wallet-badge-status ready">Universal</span>
              </div>

              {/* Rabby & Others */}
              <div className="wallet-card-custom" onClick={() => connectWalletType('rabby')}>
                <div className="wallet-card-left">
                  <div className="wallet-brand-icon">🐰</div>
                  <div className="wallet-brand-meta">
                    <b>Rabby / EIP-6963</b>
                    <small>{typeof window !== 'undefined' && (window.rabby || window.ethereum?.isRabby) ? 'Rabby Detected' : 'EIP-6963 Provider'}</small>
                  </div>
                </div>
                <span className="wallet-badge-status">EIP-6963</span>
              </div>

              {isDevMode && (
                <>
                  <p className="dev-heading">LOCAL ANVIL TEST ACCOUNTS (DEV ONLY)</p>
                  {ANVIL_ACCOUNTS.map((acc) => (
                    <div
                      key={acc.address}
                      className={`account-card ${activeAccount.address === acc.address ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveAccount(acc);
                        setShowWalletModal(false);
                      }}
                    >
                      <div className="acc-info">
                        <b>{acc.name}</b>
                        <small>{acc.address}</small>
                      </div>
                      <span className="acc-role">{acc.role}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* WalletConnect v2 Pairing Modal */}
      {showWalletConnectModal && (
        <div className="modal-bg" onClick={() => setShowWalletConnectModal(false)}>
          <div className="modal wallet-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, textAlign: 'center' }}>
            <button className="close" onClick={() => setShowWalletConnectModal(false)}>×</button>
            <p className="eyebrow">WALLETCONNECT V2</p>
            <h2>Scan with Mobile Wallet</h2>
            <p className="subtext">Scan this QR code from Rainbow, MetaMask Mobile, Coinbase, or Trust Wallet.</p>

            <div className="wc-pairing-box">
              <div className="wc-qr-placeholder">
                <span style={{ fontSize: 48 }}>📱</span>
                <span style={{ fontSize: 11, fontWeight: 700, marginTop: 8, color: '#333' }}>EIP-1193 / WC v2 RELAY</span>
                <span style={{ fontSize: 9, color: '#666', marginTop: 4 }}>Chain ID: {activeChainId}</span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Or paste this live pairing URI into your mobile wallet:</p>
              <div className="wc-uri-input">
                <input type="text" readOnly value={wcPairingUri} />
                <button
                  className="primary"
                  style={{ padding: '8px 14px', fontSize: 12 }}
                  onClick={() => {
                    navigator.clipboard.writeText(wcPairingUri);
                    alert('Pairing URI copied to clipboard!');
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            <button
              className="text-btn"
              style={{ width: '100%', marginTop: 8, fontSize: 12 }}
              onClick={() => setShowWalletConnectModal(false)}
            >
              Cancel Connection
            </button>
          </div>
        </div>
      )}

      {/* Collector Profile Modal */}
      {showProfileModal && (
        <div className="modal-bg" onClick={() => setShowProfileModal(false)}>
          <div className="modal profile-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <button className="close" onClick={() => setShowProfileModal(false)}>×</button>
            <p className="eyebrow">COLLECTOR & ARTIST PROFILE</p>
            <h2>{activeAccount.name}</h2>
            <p className="subtext">
              <AddrDisplay address={activeAccount.address} explorer={activeNetwork.explorer} />
              {' • '}{activeAccount.address}
            </p>

            <div className="profile-stats">
              <div><small>ETH BALANCE</small><b>{accountBalance} ETH</b></div>
              <div><small>OUTBID REFUNDABLE</small><b>{refundableEth} ETH</b></div>
              <div><small>LOTS CREATED</small><b>{profileData?.lotsCreated?.length ?? '...'}</b></div>
              <div><small>BIDS PLACED</small><b>{profileData?.bidsPlaced?.length ?? '...'}</b></div>
            </div>

            {parseFloat(refundableEth) > 0 && (
              <button className="primary wide" onClick={handleWithdrawRefund} disabled={txPending}>
                Withdraw {refundableEth} ETH Refund ↗
              </button>
            )}

            {/* Profile Tabs */}
            <div className="modal-tabs" style={{ marginTop: 14 }}>
              <button className={`tab-btn ${profileTab === 'created' ? 'active' : ''}`} onClick={() => setProfileTab('created')}>Created ({profileData?.lotsCreated?.length ?? 0})</button>
              <button className={`tab-btn ${profileTab === 'bids' ? 'active' : ''}`} onClick={() => setProfileTab('bids')}>Bids ({profileData?.bidsPlaced?.length ?? 0})</button>
              <button className={`tab-btn ${profileTab === 'notifications' ? 'active' : ''}`} onClick={() => setProfileTab('notifications')}>Notifications ({notifications.length})</button>
            </div>

            {profileTab === 'created' && (
              <div className="artist-works-grid" style={{ marginTop: 12 }}>
                {!profileData ? <p style={{fontSize:12,color:'#888'}}>Loading…</p> :
                  profileData.lotsCreated.length === 0 ? <p style={{fontSize:12,color:'#888'}}>No artworks created yet.</p> :
                  profileData.lotsCreated.map((l) => (
                    <div key={l.lotId} className="artist-thumb"
                      style={{ backgroundImage: l.imageUrl ? `url(${l.imageUrl})` : 'none', backgroundColor: '#1c1c20', cursor:'pointer' }}
                      onClick={() => { setShowProfileModal(false); setSelectedLot(l); }}
                      title={l.title}
                    />
                  ))
                }
              </div>
            )}

            {profileTab === 'bids' && (
              <ul className="notif-list" style={{ marginTop: 12 }}>
                {!profileData ? <li style={{fontSize:12,color:'#888'}}>Loading…</li> :
                  profileData.bidsPlaced.length === 0 ? <li style={{fontSize:12,color:'#888',listStyle:'none'}}>No bids placed yet.</li> :
                  profileData.bidsPlaced.map((b, i) => (
                    <li key={i} className="notif-item">
                      <span className="notif-icon">🟢</span>
                      <div>
                        <p className="notif-msg">{b.title || 'Lot'} — <b>{b.amountEth} ETH</b></p>
                        <small className="notif-time">{b.status?.toUpperCase()} • {new Date(b.timestamp).toLocaleString()}</small>
                      </div>
                    </li>
                  ))
                }
              </ul>
            )}

            {profileTab === 'notifications' && (
              <ul className="notif-list" style={{ marginTop: 12 }}>
                {notifications.length === 0 ? <li style={{fontSize:12,color:'#888',listStyle:'none'}}>No notifications yet.</li> :
                  notifications.slice(0, 20).map((n) => {
                    const p = n.payload || {};
                    const icons = { outbid: '🔴', bid_placed: '🟢', lot_won: '🏆', lot_settled_seller: '💰', buy_now_executed: '⚡' };
                    const labels = {
                      outbid: `Outbid on “${p.title}” — new bid ${p.newBidEth} ETH`,
                      bid_placed: `Bid ${p.amountEth} ETH on “${p.title}”`,
                      lot_won: `Won “${p.title}” for ${p.amountEth} ETH`,
                      lot_settled_seller: `“${p.title}” ${p.soldTo ? `sold for ${p.amountEth} ETH` : 'ended unsold'}`,
                      buy_now_executed: `“${p.title}” bought for ${p.amountEth} ETH`,
                    };
                    return (
                      <li key={n.id} className="notif-item">
                        <span className="notif-icon">{icons[n.type] || 'ℹ️'}</span>
                        <div>
                          <p className="notif-msg">{labels[n.type] || n.type}</p>
                          <small className="notif-time">{new Date(n.createdAt).toLocaleString()}</small>
                        </div>
                      </li>
                    );
                  })
                }
              </ul>
            )}

            <div className="profile-info-footer">
              <span>Network: <b>{activeNetwork.name}</b></span>
              <div style={{display:'flex',gap:12}}>
                <button className="text-btn" style={{fontSize:11}} onClick={() => { setShowProfileModal(false); setShowArtistApplyModal(true); }}>Apply as Artist</button>
                <button className="text-btn" style={{fontSize:11}} onClick={() => { setShowProfileModal(false); setShowRelistModal(true); }}>↺ Relist NFT</button>
                {activeNetwork.explorer && (
                  <a href={`${activeNetwork.explorer}/address/${activeAccount.address}`} target="_blank" rel="noreferrer">Etherscan ↗</a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Artwork Drop Modal */}
      {showCreateDropModal && (
        <div className="modal-bg" onClick={() => setShowCreateDropModal(false)}>
          <div className="modal form-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowCreateDropModal(false)}>×</button>
            <p className="eyebrow">ARTIST STUDIO • NEW 1/1 DROP</p>
            <h2>{dropMode === 'lazy' ? 'Create Gasless Lazy Mint Voucher' : `Mint & List Artwork on ${activeNetwork.shortName}`}</h2>

            <div className="listing-mode-selector" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
              <button
                type="button"
                className={`mode-btn ${dropMode === 'auction' ? 'active' : ''}`}
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  border: dropMode === 'auction' ? '2px solid var(--accent, #3b82f6)' : '1px solid var(--line, #333)',
                  background: dropMode === 'auction' ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => setDropMode('auction')}
              >
                <div style={{ fontWeight: 600, fontSize: '13px' }}>Timed English Auction</div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>Live reserve auction with 15m anti-snipe</div>
              </button>
              <button
                type="button"
                className={`mode-btn ${dropMode === 'lazy' ? 'active' : ''}`}
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  border: dropMode === 'lazy' ? '2px solid #8b5cf6' : '1px solid var(--line, #333)',
                  background: dropMode === 'lazy' ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => setDropMode('lazy')}
              >
                <div style={{ fontWeight: 600, fontSize: '13px' }}>⚡ Gasless Lazy Mint</div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>0 gas for artist. EIP-712 cryptographic voucher</div>
              </button>
            </div>

            <form onSubmit={handleCreateDrop}>
              <div className="form-group">
                <label>Artwork Title *</label>
                <input
                  type="text"
                  placeholder="e.g. Genesis Luminescence"
                  value={dropTitle}
                  onChange={(e) => setDropTitle(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label>Artwork Description</label>
                <textarea
                  placeholder="Describe the medium, concept, and technique..."
                  value={dropDesc}
                  onChange={(e) => setDropDesc(e.target.value)}
                  rows={3}
                />
              </div>

              {dropMode === 'auction' ? (
                <>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Reserve Price (ETH) *</label>
                      <input
                        type="number"
                        step="0.001"
                        min="0.001"
                        value={dropReserve}
                        onChange={(e) => setDropReserve(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Auction Duration (Hours) *</label>
                      <input
                        type="number"
                        min="1"
                        value={dropDurationHours}
                        onChange={(e) => setDropDurationHours(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Instant Settle / Buy Now Price (ETH, Optional)</label>
                    <input
                      type="number"
                      step="0.001"
                      min={dropReserve || '0.001'}
                      placeholder="e.g. 5.0 (Leave blank for pure auction)"
                      value={dropBuyNow}
                      onChange={(e) => setDropBuyNow(e.target.value)}
                    />
                    <small style={{ color: '#888', fontSize: '11px', marginTop: '3px', display: 'block' }}>
                      If configured, any collector can instantly purchase and conclude the auction immediately at this price.
                    </small>
                  </div>
                </>
              ) : (
                <div className="form-group">
                  <label>Mint & Claim Price (ETH) *</label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={dropReserve}
                    onChange={(e) => setDropReserve(e.target.value)}
                    required
                  />
                  <small style={{ color: '#888', fontSize: '11px', marginTop: '3px', display: 'block' }}>
                    Collector will pay this amount + gas to mint upon purchase. Net proceeds are transferred directly to your wallet.
                  </small>
                </div>
              )}

              <div className="form-group">
                <label>Artwork Image (PNG, JPG, WEBP, SVG, GIF) *</label>
                <input type="file" accept="image/*" onChange={handleImageSelect} required />
              </div>

              {imagePreviewUrl && (
                <div className="image-preview">
                  <img src={imagePreviewUrl} alt="Artwork Preview" />
                </div>
              )}

              <button type="submit" className="primary wide" disabled={txPending}>
                {txPending ? txStep : (dropMode === 'lazy' ? 'Sign Gasless EIP-712 Mint Voucher ↗ (0 Gas)' : `Mint 1/1 NFT & Start Auction on ${activeNetwork.shortName} ↗`)}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Artist Application Modal */}
      {showArtistApplyModal && (
        <div className="modal-bg" onClick={() => setShowArtistApplyModal(false)}>
          <div className="modal form-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowArtistApplyModal(false)}>×</button>
            <p className="eyebrow">CURATION PROGRAMME • ARTIST APPLICATION</p>
            <h2>Apply as an Artist</h2>
            <p className="subtext" style={{marginBottom:16}}>Verified curated artists get a profile badge, dedicated gallery page, and elevated placement in discovery feeds. Applications are reviewed by the curation team.</p>
            <form onSubmit={handleArtistApply}>
              <div className="form-group">
                <label>Display Name *</label>
                <input type="text" placeholder="e.g. Ada Goldfield" value={applyDisplayName} onChange={(e) => setApplyDisplayName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Artist Handle * (lowercase, 2–32 chars)</label>
                <input type="text" placeholder="e.g. ada_goldfield" value={applyHandle} onChange={(e) => setApplyHandle(e.target.value.toLowerCase())} required pattern="[a-z0-9_]{2,32}" />
              </div>
              <div className="form-group">
                <label>Artist Bio (optional)</label>
                <textarea placeholder="Describe your practice, medium, and influences..." value={applyBio} onChange={(e) => setApplyBio(e.target.value)} rows={4} />
              </div>
              <p style={{fontSize:11,color:'#888',marginBottom:14}}>Applying as: <code>{activeAccount.address}</code></p>
              <button type="submit" className="primary wide" disabled={applyPending}>
                {applyPending ? 'Submitting…' : 'Submit Artist Application ↗'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Secondary Market Relist Modal */}
      {showRelistModal && (
        <div className="modal-bg" onClick={() => setShowRelistModal(false)}>
          <div className="modal form-modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setShowRelistModal(false)}>×</button>
            <p className="eyebrow">SECONDARY MARKET • RESALE AUCTION</p>
            <h2>↺ List NFT for Sale</h2>
            <p className="subtext" style={{marginBottom:16}}>List any ERC-721 you own on the AuctionHouse. The NFT will be held in escrow until the auction settles or is cancelled.</p>
            <form onSubmit={handleRelistForSale}>
              <div className="form-group">
                <label>NFT Contract Address *</label>
                <input type="text" placeholder="0x..." value={relistNftAddress} onChange={(e) => setRelistNftAddress(e.target.value)} required />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Token ID *</label>
                  <input type="number" min="1" placeholder="1" value={relistTokenId} onChange={(e) => setRelistTokenId(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Duration (Hours) *</label>
                  <input type="number" min="1" value={relistDuration} onChange={(e) => setRelistDuration(e.target.value)} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Reserve Price (ETH) *</label>
                  <input type="number" step="0.001" min="0.001" value={relistReserve} onChange={(e) => setRelistReserve(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Buy Now Price (ETH, Optional)</label>
                  <input type="number" step="0.001" placeholder="Leave blank for pure auction" value={relistBuyNow} onChange={(e) => setRelistBuyNow(e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>Min Bid Increment (ETH)</label>
                <input type="number" step="0.001" value={relistMinIncrement} onChange={(e) => setRelistMinIncrement(e.target.value)} />
              </div>
              {relistPrefillTitle && <p style={{fontSize:12,color:'#555',marginBottom:12}}>Relisting: <b>{relistPrefillTitle}</b></p>}
              <button type="submit" className="primary wide" disabled={txPending}>
                {txPending ? txStep : 'Approve & List for Secondary Sale ↗'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Museum Cinema Lightbox Modal */}
      {lightboxImage && (
        <div className="cinema-modal-bg" onClick={() => { setLightboxImage(null); setIsZoomed(false); }}>
          <div className="cinema-container" onClick={(e) => e.stopPropagation()}>
            <div className="cinema-header">
              <div>
                <span className="cinema-title">{lightboxTitle}</span>
                <span style={{ color: '#aaa', fontSize: '13px', marginLeft: '12px' }}>by {lightboxArtist}</span>
              </div>
              <div className="cinema-controls">
                <button
                  className="cinema-btn"
                  onClick={() => setIsZoomed(!isZoomed)}
                >
                  {isZoomed ? '🔍 Fit to Screen' : '🔍 2x Zoom'}
                </button>
                <button
                  className="cinema-close"
                  onClick={() => { setLightboxImage(null); setIsZoomed(false); }}
                >
                  ×
                </button>
              </div>
            </div>
            <img
              src={lightboxImage}
              alt={lightboxTitle}
              className={`cinema-img ${isZoomed ? 'zoomed' : ''}`}
              onClick={() => setIsZoomed(!isZoomed)}
              title={isZoomed ? 'Click to fit image' : 'Click to zoom in'}
            />
          </div>
        </div>
      )}

      {/* Artist Profile & Identity Modal */}
      {viewingArtist && (
        <div className="modal-bg" onClick={() => setViewingArtist(null)}>
          <div className="modal wallet-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '620px' }}>
            <button className="close" onClick={() => setViewingArtist(null)}>×</button>
            <p className="eyebrow">VERIFIED CREATOR DOSSIER</p>
            <div className="artist-profile-box">
              <div className="artist-header-card">
                <div className="artist-avatar">
                  {viewingArtist.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="artist-titles">
                  <h3>{viewingArtist.name}</h3>
                  <p>{viewingArtist.handle ? `@${viewingArtist.handle}` : 'Curated 1/1 Digital Artist'}</p>
                  <code style={{cursor:'pointer'}} onClick={() => navigator.clipboard.writeText(viewingArtist.address)} title="Click to copy">
                    <AddrDisplay address={viewingArtist.address} explorer={activeNetwork.explorer} />
                  </code>
                </div>
              </div>

              <div style={{ fontSize: '13px', color: '#555', lineHeight: '1.5', background: '#fbf9f5', padding: '14px', borderRadius: '4px', border: '1px solid var(--line)' }}>
                <b>Artist Statement & On-Chain Provenance:</b>
                <p style={{ margin: '6px 0 0' }}>
                  Independent digital artist deploying scarce cryptographic works directly to Ethereum smart contracts with non-custodial custody and EIP-2981 perpetual royalties.
                </p>
              </div>

              <div>
                <p className="artist-gallery-title">ARTWORK IN PATRONAGE REPERTOIRE</p>
                <div className="artist-works-grid">
                  {lotsState.lots
                    .filter((l) => l.creator.toLowerCase() === viewingArtist.address.toLowerCase())
                    .map((l) => (
                      <div
                        key={l.lotId}
                        className="artist-thumb"
                        style={{ backgroundImage: l.imageUrl ? `url(${l.imageUrl})` : 'none', backgroundColor: '#1c1c20' }}
                        onClick={() => {
                          setViewingArtist(null);
                          setSelectedLot(l);
                        }}
                        title={`View ${l.title}`}
                      />
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gasless Lazy Mint Voucher Detail Modal */}
      {selectedVoucher && (
        <div className="modal-bg" onClick={() => setSelectedVoucher(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" aria-label="Close" onClick={() => setSelectedVoucher(null)}>×</button>
            <div
              className="modal-art"
              style={{ backgroundImage: selectedVoucher.imageUrl ? `url(${selectedVoucher.imageUrl})` : 'none', backgroundColor: '#111', cursor: 'zoom-in' }}
              onClick={() => {
                setLightboxImage(selectedVoucher.imageUrl || null);
                setLightboxTitle(selectedVoucher.title || 'Untitled artwork');
                setLightboxArtist(selectedVoucher.artistName || 'Artist');
                setIsZoomed(false);
              }}
              title="Click to view in Cinema Lightbox"
            >
              <span>1 / 1 • Cinema View 🔍</span>
            </div>
            <div className="modal-info">
              <p className="eyebrow">GASLESS LAZY MINT • EIP-712 VOUCHER</p>
              <h2>{selectedVoucher.title || 'Untitled artwork'}</h2>
              <p
                className="artist-name"
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => setViewingArtist({
                  name: selectedVoucher.artistName || 'Artist',
                  handle: '',
                  address: selectedVoucher.artist,
                })}
                title="View creator profile"
              >
                {selectedVoucher.artistName || 'Artist'}
              </p>

              <div className="contract-details-box">
                <small>EIP-712 CRYPTOGRAPHIC SIGNATURE & PROVENANCE</small>
                <div className="spec-row">
                  <span>Artist / Signer:</span>
                  <code title={selectedVoucher.artist}>
                    <AddrDisplay address={selectedVoucher.artist} explorer={activeNetwork.explorer} />
                  </code>
                </div>
                <div className="spec-row">
                  <span>Target NFT Contract:</span>
                  <code title={selectedVoucher.nftAddress}>
                    {selectedVoucher.nftAddress.slice(0, 8)}…{selectedVoucher.nftAddress.slice(-6)}
                  </code>
                </div>
                <div className="spec-row">
                  <span>Voucher Nonce:</span>
                  <b>{selectedVoucher.nonce}</b>
                </div>
                <div className="spec-row">
                  <span>Signature Status:</span>
                  <b style={{ color: '#10b981' }}>✓ EIP-712 Verified Artist Signature</b>
                </div>
                <div className="spec-row">
                  <span>Gas Policy:</span>
                  <b>0 gas for artist. Collector mints directly to wallet.</b>
                </div>
              </div>

              <div className="modal-cta-box" style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <div>
                    <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MINT & CLAIM PRICE</span>
                    <div style={{ fontSize: 24, fontWeight: 700 }}>
                      {selectedVoucher.minPriceEth} ETH <span style={{ fontSize: 14, color: '#888', fontWeight: 400 }}>({formatUsd(selectedVoucher.minPriceEth)})</span>
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>● Ready to Mint</span>
                </div>

                <button
                  className="primary wide"
                  onClick={() => handleMintVoucher(selectedVoucher)}
                  disabled={txPending}
                >
                  {txPending ? txStep : `Mint & Collect 1/1 NFT for ${selectedVoucher.minPriceEth} ETH ↗`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Progress Toast */}
      {txPending && (
        <div className="tx-toast">
          <div className="spinner" />
          <div className="toast-content">
            <b>{txStep}</b>
            {lastTxHash && activeNetwork.explorer && (
              <a href={`${activeNetwork.explorer}/tx/${lastTxHash}`} target="_blank" rel="noreferrer">
                View on Etherscan ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
