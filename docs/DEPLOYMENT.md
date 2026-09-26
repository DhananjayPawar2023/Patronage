# Patronage Base Sepolia & Public Deployment Guide

---

## Overview

This guide details the step-by-step procedure for deploying the **Patronage Digital Art Marketplace** to public EVM networks, specifically **Base Sepolia Testnet** (Chain ID: `84532`) and **Base Mainnet** (Chain ID: `8453`).

---

## 1. Environment Configuration Checklist

Create a `.env` file in the root workspace directory with the following variables:

```bash
# Network & RPC Configuration
CHAIN_ID=84532
RPC_URL=https://sepolia.base.org
DEPLOYER_PRIVATE_KEY=0x... # Funded with Base Sepolia ETH

# Platform Protocol Treasury & Parameters
PROTOCOL_TREASURY_ADDRESS=0x... # Receiver for platform fees
PROTOCOL_FEE_BPS=250 # 2.5% protocol fee
ANTI_SNIPE_WINDOW_SECONDS=300 # 5-minute extension window

# Storage & IPFS Configuration
PINATA_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs

# Backend API & Database
API_PORT=8787
VITE_API_BASE_URL=https://api.patronage.art
DATABASE_URL="file:./dev.db" # Or PostgreSQL connection string
```

---

## 2. Order of Operations for Deployment

### Step 1: Compile Smart Contracts & Run Security Tests
```bash
# Compile contracts and generate ABI artifacts
npm run compile

# Run master security test suite
node scripts/test-final-suite.mjs
```

### Step 2: Deploy Contracts to Base Sepolia
```bash
# Execute deployment script targeting Base Sepolia RPC
node scripts/deploy-contracts.mjs --network base-sepolia
```
*Outputs deployment manifest to `contracts/deployments/84532.json`.*

### Step 3: Run Database Migrations
```bash
# Apply Prisma database schema
npx prisma db push
```

### Step 4: Launch Event Indexer Engine
```bash
# Start Viem event indexer watching Base Sepolia logs
node services/indexer/index.mjs
```

### Step 5: Launch Backend REST API
```bash
# Start production API server
node api/server.mjs
```

### Step 6: Build & Deploy Frontend Web Application
```bash
# Build Vite production bundle
npm run build
```

---

## 3. Health Checks & Verification Procedures

1. **API Health Endpoint**:
   ```bash
   curl -i https://api.patronage.art/health
   # Expected: HTTP 200 {"status":"ok","service":"patronage-api"}
   ```

2. **Deployment Manifest Check**:
   ```bash
   curl -i https://api.patronage.art/api/deployment
   # Expected: HTTP 200 with contract addresses for AuctionHouse, PatronEdition, ArtworkNFT, ArtistFactory
   ```

3. **SIWE Nonce Endpoint**:
   ```bash
   curl -i https://api.patronage.art/api/siwe/nonce
   # Expected: HTTP 200 {"nonce":"..."}
   ```

4. **Indexer Block Progress Check**:
   Query `IndexedEvent` table in SQLite/PostgreSQL to verify `blockNumber` is updating alongside Base Sepolia block production.

---

## 4. Emergency Rollback Plan

If a critical flaw or RPC failure is encountered during deployment:

1. **Pause AuctionHouse Contract**:
   Call `AuctionHouse.pause()` using account assigned `OPERATOR_ROLE` to freeze bidding and lot creation.
2. **Stop Indexer Service**:
   Terminate the `services/indexer/index.mjs` process to halt database writes.
3. **Revert Frontend DNS / CDN**:
   Point frontend web domain back to previous static release bundle or maintenance notice.
4. **Fund Escrow Safety**:
   All active bids remain escrowed in `AuctionHouse.sol`. Bidders can withdraw outbid/cancelled balances via `withdrawRefund()`.
