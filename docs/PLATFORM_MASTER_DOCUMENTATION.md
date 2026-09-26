# 🏛️ Patronage — Master Platform Documentation & Engineering Manual

> **Version:** 1.0.0 Production Architecture  
> **Standard Compliance:** ERC-721, ERC-2981, EIP-4361 (SIWE), EIP-1193  
> **Design Philosophy:** SuperRare / RareProtocol Sovereign Curation Model  
> **Cost Model:** 100% Free & Open-Source Infrastructure  

---

## 📑 Table of Contents

1. [Executive Summary & Architecture Overview](#1-executive-summary--architecture-overview)
2. [Zero-Cost Free Infrastructure Guide](#2-zero-cost-free-infrastructure-guide)
3. [Smart Contract Suite & On-Chain Mechanics](#3-smart-contract-suite--on-chain-mechanics)
4. [Security Architecture & Audit Resolution](#4-security-architecture--audit-resolution)
5. [EIP-4361 Sign-In With Ethereum (SIWE) Engine](#5-eip-4361-sign-in-with-ethereum-siwe-engine)
6. [Event Indexer & Real-Time Sync Pipeline](#6-event-indexer--real-time-sync-pipeline)
7. [API Specification & Server Endpoints](#7-api-specification--server-endpoints)
8. [Frontend & Museum-Grade Collector Experience](#8-frontend--museum-grade-collector-experience)
9. [Operator Manual: Running, Testing & Deploying](#9-operator-manual-running-testing--deploying)

---

## 1. Executive Summary & Architecture Overview

**Patronage** is a decentralized, non-custodial 1/1 digital art marketplace inspired by **SuperRare**, **RareProtocol**, and **Foundation**. It is engineered to give artists complete sovereignty over their smart contracts and artwork royalties while providing collectors with institutional-grade escrow security, anti-snipe auction protection, and real-time live auction bidding.

### System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19 + Vite)                      │
│   • Dark Museum Gallery Aesthetics     • Real-time SSE Stream Listener │
│   • Viem Browser Wallet Connectors     • Escrow Refund Claim Widget    │
│   • Multi-Network Switcher (Local/Testnet/Mainnet)                     │
└───────────────────▲────────────────────────────────▲───────────────────┘
                    │ JSON-RPC (eth_call, txs)       │ HTTP / SSE Stream
                    │                                │
┌───────────────────▼─────────────┐   ┌──────────────▼──────────────────┐
│   EVM BLOCKCHAIN (Anvil/Base)   │   │     NODE.JS BACKEND (Port 8787) │
│                                 │   │                                 │
│  • AuctionHouse.sol             │   │  • EIP-4361 SIWE Session Auth   │
│    - Pull Escrow (refundable)   │   │  • Secure Image & Metadata PUT  │
│    - Anti-Snipe Countdown       │   │  • REST APIs (/api/lots, etc.)  │
│    - Instant Buy Now            │   │  • SSE Broadcast Engine         │
│  • ArtworkNFT.sol (ERC-721/2981)│   └─────────────────▲───────────────┘
│  • PatronEdition.sol            │                     │
│  • ArtistFactory.sol            │   ┌─────────────────┴───────────────┐
│  • Treasury.sol                 │   │     LOCAL EVENT INDEXER         │
│  • PlatformRegistry.sol         │   │                                 │
└─────────────────▲───────────────┘   │  • viem poll for on-chain logs  │
                  │                   │  • Atomic Prisma Transactions   │
                  │                   │  • SQLite Storage (dev.db)      │
                  └───────────────────┴─────────────────────────────────┘
```

---

## 2. Zero-Cost Free Infrastructure Guide

The entire platform is purposefully designed to run without any paid cloud subscriptions, enterprise SaaS, or credit cards.

| Layer | Free Tool / Provider | Configuration / Zero-Cost Benefit |
| :--- | :--- | :--- |
| **Local EVM Chain** | **Foundry Anvil** (`tools/foundry/anvil.exe`) | Instant sub-second mining, deterministic accounts, 10,000 test ETH per account. Zero gas fees. |
| **Public L2 Testnet** | **Base Sepolia (Chain ID `84532`)** | 2-second block times, sub-cent gas fees. Free faucet available via Coinbase Developer Platform (`coinbase.com/faucets`) or Superchain faucet. Public RPC: `https://sepolia.base.org`. |
| **Public L1 Testnet** | **Ethereum Sepolia (Chain ID `11155111`)** | Canonical Ethereum testnet. Free faucets via Google Cloud Web3 / `sepoliafaucet.com`. Public RPC: `https://ethereum-sepolia-rpc.publicnode.com`. |
| **Decentralized Storage** | **Pinata IPFS Free Tier** + Local Fallback | 1 GB storage, 500 files free. Multi-gateway client fallback (`ipfs.io`, `cloudflare-ipfs.com`, `dweb.link`). |
| **Database** | **SQLite + Prisma ORM** | Single-file zero-maintenance database (`dev.db`). No cloud server or RDS instance required. |
| **Authentication** | **EIP-4361 SIWE (Cryptographic)** | Native Web3 wallet signatures. Zero cost compared to Auth0 / Clerk ($25+/mo). |
| **RPC & Node** | **Viem + Public Nodes** | Standard JSON-RPC transports connecting to community public endpoints with automatic fallback. |

---

## 3. Smart Contract Suite & On-Chain Mechanics

All contracts are written in Solidity `^0.8.24` and leverage OpenZeppelin Contracts `v5.2.0`.

### Contract Inventory

1. **`AuctionHouse.sol`**:
   - **Reserve Price English Auctions**: An auction starts in a dormant/cold state. The first bid that meets or exceeds `reservePrice` starts the official countdown timer.
   - **Pull-Over-Push Escrow (`refundable[account]`)**: When a bidder is outbid or when a payment recipient fails to receive ETH, the funds are credited directly to `refundable[account]`. This eliminates external call reverts and completely prevents re-entrancy and Denial of Service (DoS) attacks.
   - **Anti-Snipe Window**: Configured to 15 minutes (`antiSnipeWindow = 900`). Any bid received with less than 15 minutes remaining extends the auction end time by 15 minutes from the current block timestamp.
   - **Instant "Buy Now"**: Sellers can specify a `buyNowPrice`. Any collector calling `buyNow{value: buyNowPrice}(lotId)` instantly settles the auction, transfers the NFT to the buyer, credits the seller and royalty receivers, and moves the previous highest bidder's locked funds into their `refundable` escrow balance.
   - **Min Bid Increment**: Configurable per lot (e.g., 5% or 0.01 ETH minimum jump).

2. **`ArtworkNFT.sol`**:
   - Implements `ERC721URIStorage`, `ERC2981` (on-chain secondary royalties), and `AccessControl`.
   - **Sequential Token Minting**: Each artist collection tracks `nextTokenId` starting from 1, allowing sovereign collections to host entire series.
   - **Royalty Routing**: Creator address is permanently registered as the royalty receiver via EIP-2981, guaranteeing perpetual secondary royalties across all compliant marketplaces.

3. **`PatronEdition.sol`**:
   - Non-transferable / Soulbound Patronage Edition.
   - Allows supporters who cannot afford the main 1/1 artwork to mint an edition during the live auction window, creating an on-chain ledger of sponsors.
   - Secure withdrawal logic protected by `DEFAULT_ADMIN_ROLE`.

4. **`ArtistFactory.sol`**:
   - SuperRare minimal-proxy clone factory enabling verified artists to deploy their own branded ERC-721 contract with custom name and symbol in a single transaction.

5. **`Treasury.sol` & `PlatformRegistry.sol`**:
   - Non-custodial protocol treasury for platform fee accumulation and centralized role registry.

---

## 4. Security Architecture & Audit Resolution

The codebase underwent a complete 12-point security audit covering smart contract execution, escrow invariants, backend APIs, and indexer reliability.

### Key Audit Issues Resolved

| Issue ID | Severity | Description | Final Resolution |
| :--- | :--- | :--- | :--- |
| **CRIT-1** | Critical | Re-entrancy on external ETH transfers | Replaced push transfers with pull-over-push escrow (`refundable[account]`) and OpenZeppelin `ReentrancyGuard`. |
| **CRIT-2** | Critical | Reserve price bypass | Strict EVM assertions requiring `msg.value >= lot.reservePrice` for the opening bid. |
| **CRIT-3** | Critical | Auction snipe griefing | Anti-snipe countdown extension (15 min) prevents MEV bots from stealing lots in the final block. |
| **CRIT-4** | Critical | Escrow insolvency risk | Verified invariant with 128,000 fuzz calls: `address(this).balance >= sum(refundable)`. |
| **HIGH-1** | High | Unrestricted collection re-initialization | Added `initialized` flag check to prevent re-calling `initialize()` on cloned contracts. |
| **HIGH-2** | High | File upload path traversal & MIME confusion | Strict magic-byte MIME validation (PNG, JPEG, WEBP, GIF, SVG) and sanitized basename extraction. |
| **MED-1** | Medium | Hardcoded single token ID in NFT | Implemented dynamic sequential token ID incrementing (`nextTokenId++`). |
| **MED-2** | Medium | Indexer race conditions & partial states | Wrapped event indexing in Prisma `$transaction` blocks ensuring atomic database updates. |
| **BLK-01** | High | Outbid fund push failures stalling lots | Converted all outbid refunds to pull escrow claimable via `withdrawRefund()`. |
| **BLK-02** | High | SIWE replay attacks | Implemented single-use nonce consumption: nonces are deleted immediately upon validation. |
| **BLK-03** | Medium | Unchecked zero-address configurations | Added `InvalidCreator()` and zero-address checks in constructors and setters. |
| **BLK-04** | Medium | Hard dependency on third-party cloud storage | Created abstract `StorageProvider` interface with seamless automatic fallback to local storage. |

---

## 5. EIP-4361 Sign-In With Ethereum (SIWE) Engine

User authentication is 100% cryptographic and decentralized.

### Authentication Flow

```
User Wallet                  Frontend                      Backend API
    │                           │                               │
    │ 1. Request Sign-In        │                               │
    │──────────────────────────>│ 2. GET /api/siwe/nonce        │
    │                           │──────────────────────────────>│
    │                           │<──────────────────────────────│
    │                           │    { nonce: "abc123xyz" }     │
    │                           │                               │
    │ 3. Prompt Signature       │                               │
    │    (EIP-4361 message)     │                               │
    │<──────────────────────────│                               │
    │                           │                               │
    │ 4. Return Signature       │                               │
    │──────────────────────────>│ 5. POST /api/siwe/verify      │
    │                           │    { address, msg, sig, nonce}│
    │                           │──────────────────────────────>│
    │                           │                               │ 6. Consume nonce
    │                           │                               │ 7. viem.verifyMessage()
    │                           │                               │ 8. Create session
    │                           │<──────────────────────────────│
    │                           │    { session: { token, exp } }│
    │                           │                               │
```

- **Replay Protection**: Nonces expire in 5 minutes and are permanently deleted on the first verification attempt.
- **Session Tokens**: Cryptographically random 256-bit bearer tokens stored in-memory with automatic cleanup upon expiration or `/api/siwe/logout`.

---

## 6. Event Indexer & Real-Time Sync Pipeline

The indexer (`services/indexer/index.mjs`) continuously monitors the EVM blockchain and populates the SQLite database for sub-millisecond query responses in the frontend.

### Indexed Events

- `LotCreated(uint256 indexed lotId, address indexed nftContract, uint256 indexed tokenId, ...)`
- `BidPlaced(uint256 indexed lotId, address indexed bidder, uint256 amount, uint256 endTime)`
- `BuyNowExecuted(uint256 indexed lotId, address indexed buyer, uint256 amount)`
- `LotSettled(uint256 indexed lotId, address indexed winner, uint256 amount)`
- `LotCancelled(uint256 indexed lotId)`
- `PatronEditionMinted(uint256 indexed lotId, address indexed patron, uint256 tokenId)`

### Real-Time SSE Stream

Whenever an event is processed, the backend fires a Server-Sent Event (`broadcastSse('lots_updated', data)`) over the `/api/stream` endpoint. All active browser tabs instantly refresh their lot cards, countdown timers, and bidder rankings without requiring manual page reloads.

---

## 7. API Specification & Server Endpoints

Base URL: `http://127.0.0.1:8787` (configured via `VITE_API_BASE_URL`)

### Public Endpoints

- `GET /health`: Returns service health status and timestamp.
- `GET /api/health/indexer`: Returns indexer lag, current block, and last processed block.
- `GET /api/deployment`: Returns contract addresses and ABIs for the active chain.
- `GET /api/lots`: Paginated, searchable, and filterable marketplace lots.
  - Query params: `page`, `limit`, `q` (keyword search), `status` (`active`, `settled`, `cancelled`), `sort` (`newest`, `ending_soon`, `highest_bid`, `reserve`).
- `GET /api/lots/:id`: Detailed view of a single lot including full bid provenance.
- `GET /api/stream`: Persistent Server-Sent Events (SSE) connection for live UI updates.
- `GET /uploads/:filename`: Serves uploaded images and artwork metadata JSON files.

### Authenticated Endpoints (Requires `Authorization: Bearer <token>`)

- `POST /api/upload`: Uploads artwork image base64, creates metadata JSON, and stores on IPFS/local storage.
- `POST /api/siwe/logout`: Revokes active SIWE session token.
- `GET /api/admin/artists`: Lists artist applications for curation.
- `POST /api/admin/artists/:id/approve`: Approves artist and grants verified badge.

---

## 8. Frontend & Museum-Grade Collector Experience

Built with **React 19**, **Vite**, and customized **Vanilla CSS**, featuring:

- **Museum Dark Mode Design**: Deep palette (`#0a0b0e`, `#111318`, `#1a1d26`), curated typography, smooth CSS transitions, and subtle glowing borders.
- **Cinema Lightbox Mode**: High-resolution zoom inspection for 1/1 artworks.
- **Dynamic Refund Notification**: If a collector is outbid, a prominent gold badge appears in the top navigation bar (`Withdraw X.XX ETH`), allowing instant 1-click escrow redemption.
- **Multi-Network Selector**: Pre-configured support for Anvil Localhost, Base Sepolia, Ethereum Sepolia, Base Mainnet, and Ethereum Mainnet.
- **Dual Signer Modes**:
  1. **Browser Wallets**: Standard MetaMask, Coinbase Wallet, Rabby, and Rainbow via `window.ethereum`.
  2. **Developer Switcher**: 1-click switching between pre-funded local personas (Artist / Alice / Bob).

---

## 9. Operator Manual: Running, Testing & Deploying

### Prerequisites

- Node.js `v20+` or `v24+`
- Foundry binaries (already included in `tools/foundry/`)

### 1. Starting the Entire Stack Locally

Run each command in a separate terminal:

```bash
# Terminal 1: Start Local EVM Blockchain
npm run dev:chain

# Terminal 2: Deploy Smart Contracts Locally
npm run deploy:local

# Terminal 3: Start Backend API Server
npm run api

# Terminal 4: Start Blockchain Event Indexer
npm run indexer

# Terminal 5: Start Frontend Dev Server
npm run dev:web
```

The application will be accessible at: **`http://127.0.0.1:4173/`**

### 2. Running Test Suites

```bash
# 1. Smart Contract Invariant & Fuzzing Suite (Forge)
npm run contracts:test

# 2. Production Audit Test Suite (All 12 issues)
node scripts/test-final-suite.mjs

# 3. End-to-End Vertical Slice Acceptance Test
npm run test:local-vertical

# 4. API Security & Header Validation
npm run test:api-security

# 5. SIWE Runtime Auth & Replay Test
npm run test:siwe-runtime

# 6. Cold Start Verification
node scripts/verify-cold-start.mjs
```

### 3. Deploying to Free Public Testnets (e.g., Base Sepolia)

1. Obtain free Base Sepolia ETH from `https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet`.
2. Configure `.env`:
   ```ini
   RPC_URL="https://sepolia.base.org"
   CHAIN_ID="84532"
   DEPLOYER_PRIVATE_KEY="0xYOUR_TESTNET_PRIVATE_KEY"
   ```
3. Deploy contracts to testnet:
   ```bash
   node scripts/deploy.mjs
   ```
4. Build the production frontend:
   ```bash
   npm run build
   ```
   The generated static bundle in `dist/` can be hosted for **free** on Vercel, Cloudflare Pages, or GitHub Pages.

---

*Authored for the Patronage 1/1 Digital Art Marketplace. All systems verified and operational.*
