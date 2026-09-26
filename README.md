# Patronage — Digital Art Marketplace & Patronage Platform

> **A local-first, zero-cloud digital art auction platform built with Solidity, Viem, React, and SQLite.**

---

## 🌟 Key Features

* **Non-Custodial Timed English Auctions (`AuctionHouse.sol`)**: Escrowed NFT auctions with anti-snipe extensions and pull-refund safety (`refundable` mapping).
* **Soulbound Support Tokens (`PatronEdition.sol`)**: Non-transferable ERC-1155 tokens minted during auction windows to support artists.
* **EIP-1167 Minimal Proxy Collections (`ArtistFactory.sol` & `ArtworkNFT.sol`)**: Gas-efficient artist collection deployment with custom collection names and EIP-2981 royalty routing.
* **EIP-4361 Sign-In With Ethereum (SIWE)**: Cryptographic wallet signature verification with single-use nonce replay protection (`src/auth/siwe.mjs`).
* **Dual Storage Architecture (`src/providers/storage.mjs`)**: Pinata IPFS provider adapter with graceful fallback to local file storage (`LocalStorageProvider`).
* **Atomic Event Indexer (`services/indexer/index.mjs`)**: Viem event listener committing database entity updates via `prisma.$transaction([])`.

---

## 🏗️ Architecture Overview

```text
+-----------------------+     +------------------------+     +-------------------------+
|   React + Vite UI     | --> |   Node.js REST API     | --> |  LocalStorage / IPFS    |
| (Viem Wallet Connect) |     |  (SIWE Auth + Uploads) |     | (Pinata Provider)       |
+-----------------------+     +------------------------+     +-------------------------+
           |                              |
           v                              v
+-----------------------+     +------------------------+
|  Local Anvil / Base   | --> |  Viem Event Indexer    | --> [ SQLite Database dev.db ]
|  Sepolia EVM Chain    |     | (Atomic $transaction)  |
+-----------------------+     +------------------------+
```

---

## 🚀 Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Compile smart contracts
npm run compile

# 3. Run master test suite (Unit, Fuzz, SIWE, Upload, Indexer)
node scripts/test-final-suite.mjs

# 4. Start local development environment (Chain + Indexer + API + Web App)
npm run dev
```

Visit `http://localhost:5173` in your browser.

---

## 🧪 Master Test Suite

Execute the complete 7-suite verification script:

```bash
node scripts/test-final-suite.mjs
```

---

## 📖 Documentation

* [docs/ARCHITECTURE.md](file:///c:/Users/Umesh/Desktop/superrare/docs/ARCHITECTURE.md) — Detailed system architecture and contract layouts.
* [docs/SECURITY.md](file:///c:/Users/Umesh/Desktop/superrare/docs/SECURITY.md) — Security threat model, trust boundaries, and fund flows.
* [docs/production-audit.md](file:///c:/Users/Umesh/Desktop/superrare/docs/production-audit.md) — Single Source of Truth production audit checklist (12/12 resolved).
* [docs/DEPLOYMENT.md](file:///c:/Users/Umesh/Desktop/superrare/docs/DEPLOYMENT.md) — Base Sepolia testnet deployment guide.
* [docs/PROJECT_STATUS.md](file:///c:/Users/Umesh/Desktop/superrare/docs/PROJECT_STATUS.md) — Project status dashboard & metrics.
* [CHANGELOG.md](file:///c:/Users/Umesh/Desktop/superrare/CHANGELOG.md) — Release 1.0.0 changelog.
