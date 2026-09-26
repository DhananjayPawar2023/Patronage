# Patronage System Architecture

Patronage is a local-first non-custodial 1/1 digital art auction platform.

---

## Subsystem Overview

```
 ┌────────────────────────┐      ┌────────────────────────┐
 │   React / Vite UI      │      │     Local REST API     │
 └───────────┬────────────┘      └───────────┬────────────┘
             │                               │
             ▼                               ▼
 ┌────────────────────────┐      ┌────────────────────────┐
 │   Local EVM Chain      │─────►│   Viem Event Indexer   │
 │   (Anvil / Ganache)    │      │   SQLite DB (dev.db)   │
 └────────────────────────┘      └────────────────────────┘
```

### 1. Smart Contracts
- **AuctionHouse**: Manages non-custodial timed English auctions, minimum bid increments, anti-snipe extensions, pull refunds, and settlement splits.
- **PatronEdition**: Soulbound support token minted exclusively during active auction lots.
- **ArtworkNFT**: ERC-721 token representing 1/1 digital artwork with EIP-2981 royalty support.
- **ArtistFactory**: EIP-1167 minimal proxy factory for deploying artist-specific artwork collections.
- **PlatformRegistry**: Governs platform components and artist permissions.
- **Treasury**: Escrows protocol revenue with role-based access control for withdrawals.

### 2. Off-chain Indexer & Storage
- **Viem Event Indexer**: Subscribes to smart contract log streams and indexes state updates to SQLite.
- **LocalStorageProvider**: Serves uploaded media assets and metadata files locally without third-party dependencies.
