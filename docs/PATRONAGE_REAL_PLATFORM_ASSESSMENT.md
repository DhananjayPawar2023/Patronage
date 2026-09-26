# Patronage: Real Platform Technical Assessment

Date: 2026-08-30  
Scope: local-first NFT art auction platform  
Status: active engineering work; not production-ready

## Executive summary

Patronage is currently a local development system with a React frontend, Solidity contracts, a Node API, a Prisma/SQLite database, local file storage, and an event indexer. It can execute genuine transactions on a local Anvil blockchain. It is not yet a complete public NFT marketplace.

The important distinction is:

- Local blockchain activity can be real without being public. A mint or auction on Anvil is a genuine EVM transaction, but it disappears when the local chain is reset and is not visible on Base, Ethereum, or another public network.
- A file stored in `uploads/` is real local data, but it is not durable decentralized storage and cannot be retrieved by other machines.
- A database row is an index of blockchain activity, not the source of ownership truth. Contract state and transaction receipts are authoritative.
- A successful frontend build proves compilation only. It does not prove wallet signing, authorization, indexing, settlement, or recovery.

## What exists today

### Frontend

The React/Vite application includes:

- Marketplace lot listing and lot detail views.
- Local Anvil development wallet accounts.
- Injected wallet support when available.
- Artwork creation flow.
- Upload request to the local API.
- Collection deployment/creation, NFT minting, approval, lot creation, bidding, Patron Edition minting, settlement, and refund actions.
- Wallet balance and transaction feedback.
- API-driven lot and bid data.

The frontend is functional as a development shell, but it remains tightly concentrated in `src/main.jsx`. It needs proper route separation, transaction state recovery, accessibility, authorization-aware UI, and honest empty/error states.

### Smart contracts

The contracts currently include:

- `ArtworkNFT.sol`: ERC-721 artwork collection.
- `ArtistFactory.sol`: artist collection creation.
- `AuctionHouse.sol`: lots, bids, pull refunds, cancellation, settlement, protocol fees, royalties, and Patron Edition routing.
- `PatronEdition.sol`: ERC-1155 patron tokens and mint pricing.
- `PlatformRegistry.sol` and `Treasury.sol`.

The contracts use real on-chain state. AuctionHouse validates lot timing, minimum bids, duplicate settlement, cancellation, payment failures, and Patron Edition lifecycle. Failed seller/royalty/treasury payments become withdrawable balances rather than silently disappearing.

Contract tests currently cover the major requested edge cases and fuzz paths, but independent security analysis and broader invariant coverage are still required before deployment.

### Local blockchain and deployment

The local toolchain uses Foundry Anvil and deterministic accounts. `scripts/local-dev.mjs` can:

1. Load local environment configuration.
2. Compile Solidity and generate artifacts.
3. Synchronize the Prisma database.
4. Start Anvil when the RPC is unavailable.
5. Deploy and configure contracts.
6. Start the API, indexer, and Vite.
7. Check service health.

The deployment manifest contains addresses and ABIs for the local chain. These addresses are valid only for the current Anvil chain state. If Anvil is reset, contracts must be redeployed and all derived data must be rebuilt.

### API

The API currently provides:

- API health.
- Indexer health and lag.
- Deployment manifest access.
- Indexed lots and lot details.
- SIWE nonce and verification endpoints.
- Local artwork upload and metadata generation.
- Protected route families for upload, administration, moderation, and settlement operations.

The API is a lightweight Node HTTP server. It is appropriate for local development, but it needs stronger production infrastructure: a mature HTTP framework or equivalent middleware, persistent sessions, durable rate limiting, schema validation, request tracing, structured logs, database transactions, and graceful shutdown.

### Database

Prisma models currently cover artists, lots, bids, Patron Edition mints, indexed events, indexer checkpoints, notifications, and related derived state. SQLite is the local default.

The database is not the ownership authority. It must be rebuildable entirely from chain events. Production requires PostgreSQL migrations, indexes designed for marketplace queries, backups, retention policies, and tested rollback procedures.

### Storage and metadata

The local storage provider writes artwork and JSON metadata into `uploads/`. Metadata follows an IPFS-style shape and returns a local URI/public URL.

This is real local storage, not IPFS. For production, the same `StorageProvider` interface should be implemented by an IPFS pinning provider. The provider must persist:

- Original artwork.
- Thumbnail and preview derivatives.
- Metadata JSON.
- Content identifiers.
- MIME type, byte size, checksum, and dimensions.
- Upload status and retry state.

The NFT should mint with the final immutable metadata URI only after storage succeeds and the content has a verifiable checksum.

### Indexer

The indexer reads deployment artifacts and processes contract events into the local database. It includes:

- Idempotent event upserts.
- Checkpoint block number and block hash.
- Replay configuration.
- Metadata retry handling.
- Patron Edition event indexing.
- Health output including current block, indexed block, lag, retries, and dead-letter count.
- Checkpoint hash mismatch detection and derived-state rollback.

Runtime replay and rollback have been exercised. A complete acceptance run still needs a deliberate mid-sync process kill and restart with captured evidence. Reorg handling also needs deeper chain-level tests across multiple affected blocks.

## What is genuinely real versus incomplete

### Real today in local mode

- Solidity compiles.
- Foundry tests execute.
- Anvil provides real local EVM state.
- Contracts deploy locally.
- NFT mint transactions execute on Anvil.
- Auctions accept real local ETH.
- Outbid refunds are recorded on-chain.
- Patron Edition minting executes on-chain.
- Settlement changes NFT ownership on-chain.
- Events are indexed into SQLite.
- SIWE signatures are cryptographically verified.
- Session expiry, replay rejection, logout, and revoked-session rejection have runtime tests.
- Upload authorization rejects unauthenticated requests.

### Not yet a real public platform

- No public-chain deployment has been performed.
- No production wallet/key-management system exists.
- Local deterministic private keys must never ship in a production bundle.
- Local files are not decentralized or durable storage.
- The API does not yet provide complete artist, admin, moderation, or settlement business workflows.
- PostgreSQL production operation is not fully verified.
- Slither and Solhint have not successfully run in the current environment.
- Full CI execution has not yet been demonstrated.
- Clean `pnpm install` and `pnpm dev` from a fresh clone still has lockfile/build-process issues.
- The complete authenticated upload-to-indexer vertical acceptance test is not currently passing when the indexer is absent or not managed by the same supervisor.
- Restart, checkpoint, replay, and reorg behavior require more repeatable automated acceptance scripts.

## Real NFT minting lifecycle

The correct production lifecycle is:

1. Artist connects an injected wallet.
2. API issues a one-time SIWE nonce.
3. Wallet signs a domain-bound SIWE message.
4. API verifies the signature, nonce, domain, URI, chain ID, issued-at time, and expiration.
5. API creates an authenticated session tied to the wallet address.
6. Artist creates a durable draft record.
7. Artist uploads the original artwork.
8. Storage provider validates type, size, checksum, dimensions, and malware status.
9. Provider creates thumbnails and final metadata.
10. API returns the immutable metadata URI/content identifier.
11. Artist signs an NFT mint transaction from their wallet.
12. Frontend waits for the receipt and records the transaction hash.
13. Indexer observes the mint event and verifies the receipt/block.
14. Artist approves AuctionHouse for the token.
15. Artist signs the lot creation transaction.
16. Indexer records the lot from the emitted event.
17. Collector signs a bid transaction with real native currency on the selected network.
18. AuctionHouse records the highest bid and pull-refund balance.
19. Collector may mint the Patron Edition while the lot is live.
20. After expiry, settlement transfers the NFT and distributes seller, protocol, and royalty amounts.
21. Indexer records settlement and ownership is read from the NFT contract.
22. Frontend reconciles pending transactions and displays indexed state only after confirmations.

No step should be replaced by a database-only mutation or frontend-only success message.

## Required production architecture

Every business service should depend on interfaces:

| Interface | Local implementation | Production implementation |
|---|---|---|
| `RPCProvider` | Anvil JSON-RPC | Base/Ethereum RPC with failover |
| `StorageProvider` | Local filesystem | IPFS pinning/object storage |
| `DatabaseProvider` | SQLite + Prisma | PostgreSQL + Prisma |
| `SearchProvider` | SQL search | PostgreSQL FTS or search service |
| `NotificationProvider` | Local logs/database | Email/push provider |
| `WalletProvider` | Anvil test accounts | Injected wallet, WalletConnect, custody policy |
| `ClockProvider` | System clock | System clock with monitoring |

Business logic must not import Pinata, Supabase, a specific RPC vendor, or a specific email vendor directly.

## Priority improvements

### P0: must close before production claims

1. Make clean startup deterministic on Windows and Unix.
2. Ensure one supervisor owns every child process and kills process trees on shutdown.
3. Fail startup if database, chain, API, indexer, or web readiness fails.
4. Add an automated mid-sync indexer kill/restart test.
5. Add block-hash validation, rollback, replay, and reorg acceptance tests.
6. Run Slither and Solhint in CI and resolve every finding or document an explicit justified suppression.
7. Add contract invariant tests for ownership, balances, lot transitions, refunds, and total escrow.
8. Complete SIWE domain/URI/chain validation and wallet-to-resource authorization.
9. Add body-size, MIME, checksum, rate-limit, and schema tests.
10. Remove all local private keys from production builds.
11. Make the vertical acceptance test pass from a clean machine with no manually started service.

### P1: required for a complete product

- Drafts and resumable uploads.
- Transaction reconciliation and retry UI.
- Pagination, search, filtering, sorting, and collection pages.
- Artist and collector profiles.
- Watchlists, follows, comments, notifications, and moderation.
- Admin roles and audit logs.
- PostgreSQL migrations and backup/restore testing.
- Durable sessions and a shared rate-limit store.
- Accessibility and responsive behavior.
- Docker Compose for local services.
- Observability: logs, metrics, tracing, alerts, and indexer lag dashboards.

### P2: public deployment

- Select a target chain and verify contract parameters.
- Deploy from a controlled signer or multisig.
- Verify contracts on the block explorer.
- Configure production RPC, storage, database, email, domains, and TLS.
- Run an external smart-contract audit.
- Publish legal, royalty, moderation, and custody policies.
- Establish incident response, backups, key rotation, and upgrade policy.

## Acceptance test for real local mode

The following must pass from a clean checkout:

```text
pnpm install
pnpm dev
```

Expected evidence:

- Anvil starts automatically.
- Deterministic local account is funded.
- Contracts compile and deploy.
- Deployment manifest is written.
- Database schema is synchronized.
- API, indexer, and frontend all become ready.
- Artist authenticates with an actual wallet signature.
- Artwork is stored locally and metadata is generated.
- NFT mint receipt is confirmed.
- Lot creation receipt is confirmed.
- Bid and outbid receipts are confirmed.
- Refund withdrawal is confirmed.
- Patron Edition mint receipt is confirmed.
- Settlement receipt is confirmed.
- Final NFT owner is read from the contract.
- Indexer restart resumes from checkpoint.
- Database reset and block-zero replay reproduce the same derived state.
- Forced checkpoint mismatch rolls back and rebuilds correctly.
- No hardcoded artwork, artist, auction, bid, or wallet values appear.

## Bottom line

Patronage has the core mechanics for a real local NFT auction: real EVM transactions, contracts, metadata creation, auction settlement, refunds, and indexing. It is currently a development platform, not a finished public marketplace. The next milestone is executable proof of lifecycle reliability and security, followed by PostgreSQL/IPFS/production-wallet adapters and only then public deployment.
