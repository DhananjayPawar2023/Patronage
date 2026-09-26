# Patronage: Current State and Remaining Work

This document describes what is present in the repository and what is still required to turn it into a complete local-first NFT art auction platform. It is based on source inspection and the tests that have actually been run. It is not a public-deployment readiness claim.

## Current task

Build and verify Patronage as a real local-development NFT auction platform:

`upload artwork -> generate metadata -> mint NFT -> create auction -> bid -> outbid/refund -> mint Patron Edition -> settle -> index -> display blockchain truth`

## What the repository currently has

### Frontend

- React/Vite application in `src/main.jsx` and `src/styles.css`.
- Marketplace view with indexed lots, bid history, auction status, wallet state, and transaction feedback.
- Artwork upload form that sends a real file to the local API.
- Local development wallet using deterministic Anvil accounts when no injected wallet is available.
- Injected-wallet path for a browser wallet.
- Wallet balance and refundable-balance display.
- Create-artwork flow that uploads, creates a collection, mints an NFT, approves the auction house, and creates a lot.
- Bid, withdraw-refund, settle, and Patron Edition actions wired to contract transactions.
- Runtime contract addresses and RPC URL loaded from local deployment/configuration rather than a fixed production chain.

### Smart contracts

The `contracts/src` directory contains:

- `ArtworkNFT.sol`: ERC-721 artwork implementation.
- `ArtistFactory.sol`: creates artist NFT collections.
- `AuctionHouse.sol`: creates lots, accepts bids, records outbid refunds, settles/cancels lots, and routes Patron Edition minting.
- `PatronEdition.sol`: ERC-1155 Patron Edition contract with a mint price and auction-house mint permission.
- `PlatformRegistry.sol`: registry contract for platform configuration.
- `Treasury.sol`: treasury contract.

The local deployment script generates deployment addresses and ABI data under `data/deployment-local.json`. The Patron Edition contract is connected to the Auction House during deployment, and the Auction House is granted mint permission.

### Backend API

`api/server.mjs` provides a local HTTP API for:

- Health checks.
- Listing indexed lots and individual lot details.
- Search against locally indexed data.
- Creating collections.
- Uploading artwork files.
- Reading locally stored metadata and media.
- Recording and reading auction-related data used by the frontend.

The API uses local environment loading and does not require cloud credentials.

### Database

- Prisma schema in `prisma/schema.prisma`.
- SQLite database at `prisma/dev.db` for local development.
- Models for artists, collections, artworks, lots, bids, metadata, transactions, Patron Edition mints, analytics, and indexer state.
- `IndexerState` stores the last processed block and block hash for checkpointing.
- Database schema can be pushed/reset with Prisma scripts.

PostgreSQL compatibility is partly prepared through Prisma, but a complete provider abstraction and production migration procedure are not finished.

### Storage and metadata

- Local file storage in `uploads/`.
- Uploaded artwork and JSON metadata are served by the API.
- Metadata is generated in the same JSON shape expected from an IPFS-style metadata provider.
- The storage code is structured so a future Pinata/IPFS implementation can replace the local implementation.
- Upload validation and local file handling exist, but resumable uploads, durable cleanup, virus scanning, and production provider behavior are not complete.

### Indexer

`services/indexer/index.mjs`:

- Reads local deployment artifacts.
- Reads Auction House, NFT, Artist Factory, and Patron Edition events.
- Writes indexed artists, collections, artwork, lots, bids, transactions, and Patron Edition mints to SQLite.
- Supports idempotent event upserts.
- Has a durable block checkpoint.
- Supports replay from a configured block.
- Retries unresolved metadata.
- Exposes indexer health information through the API.

Reorganization handling, rollback, dead-letter processing, precise lag reporting, and a fully demonstrated restart/rebuild workflow remain incomplete.

### Local development tooling

- Official Foundry Anvil binary is included at `tools/foundry/anvil.exe`.
- Foundry `forge`, `cast`, and `chisel` binaries are included for local Windows development.
- `scripts/local-chain.mjs` starts Anvil, checks readiness, and uses deterministic local accounts.
- `scripts/deploy-local.mjs` compiles/deploys contracts and writes deployment artifacts.
- `scripts/local-dev.mjs` orchestrates database setup, Anvil, deployment, API, indexer, and Vite.
- `.env.example` documents local defaults.

## Verified behavior

The following checks have been executed in this repository:

- `npm.cmd run build` — passed.
- `npm.cmd run compile` — passed.
- `npm.cmd run db:push` — passed.
- `npm.cmd run db:reset:local` — passed during local reset verification.
- `npm.cmd run contracts:test` — passed: 9 Foundry tests, 0 failures.
- `npm.cmd run test:local-vertical` — passed in a live local stack.

The successful vertical slice verified real local blockchain transactions for:

- Local artwork upload and metadata generation.
- Collection creation and NFT minting.
- Auction lot creation.
- A first bid and a higher second bid.
- Refund accounting for the outbid bidder.
- Patron Edition minting through the Auction House.
- Auction settlement.
- Final NFT ownership changing to the winning bidder.
- The settled lot being visible through the indexer/API.

This proves a local vertical slice, not completion of the entire product or production safety.

## What is incomplete and should be improved

### P0: required before calling the local product complete

1. **Clean cold start**
   - Verify `pnpm install` and `pnpm dev` from a clean workspace with no manually started services.
   - Make child-process lifecycle reliable on Windows so repeated starts do not leave orphaned Anvil, API, indexer, or Vite processes.
   - Add readiness checks for every service and graceful shutdown handling.

2. **Indexer restart and rebuild**
   - Prove restart from a checkpoint.
   - Prove replay from block zero after database reset.
   - Validate block hashes and implement rollback/reorg recovery.
   - Add indexer lag, current block, last successful sync, retry count, and dead-letter status to health output.

3. **Auction correctness coverage**
   - Add tests for no-bid settlement, cancellation, expired lots, duplicate settlement, duplicate Patron Edition minting, invalid increments, zero addresses, royalty bounds, payment failures, and recovery withdrawals.
   - Add fuzz and invariant tests for balances, ownership, lot state transitions, and total refundable funds.
   - Run coverage, Slither, and Solhint in CI and resolve findings.

4. **Remove stale fake data**
   - Delete any remaining old fixture files and generated artifacts in `uploads/` that contain fabricated artwork or artist data.
   - Remove stale fake-data references from generated `dist/` output by rebuilding after source cleanup.
   - Replace stale documentation that overstates completion or public-deployment readiness.
   - Keep empty states honest when the database contains no real indexed data.

5. **Secure identity and authorization**
   - Complete SIWE nonce issuance, signature verification, session expiry, logout, replay protection, and wallet-to-resource authorization.
   - Protect artist, admin, moderation, upload, and settlement-related API operations.
   - Add request schemas, body-size limits, rate limits, structured errors, and security headers.

### P1: required for a complete usable platform

- Split the frontend into routes/pages for marketplace, artwork, artist, collector, create, profile, and admin.
- Add real filtering, pagination, sorting, search, collection pages, artist pages, and transaction recovery.
- Add draft artwork records, upload progress, resumable uploads, thumbnail generation, and reconciliation when a wallet transaction is interrupted.
- Finish provider interfaces for storage, database, RPC, search, notifications, and analytics. Local implementations must be the default; production implementations must fail explicitly when not configured rather than silently hiding failures.
- Add persistent local notifications and analytics events with privacy boundaries.
- Add profiles, follows, comments, watchlists, moderation, reporting, and admin workflows backed by authorization.
- Add accessibility work: keyboard navigation, focus management, labels, screen-reader states, reduced motion, contrast, and responsive behavior.
- Improve database indexes, migration discipline, transaction boundaries, and PostgreSQL verification.
- Add transaction records and confirmation tracking for every user-visible blockchain operation.

### P2: production preparation

- Remove bundled private keys from production builds and gate the local wallet behind an explicit development mode.
- Add Docker Compose for Anvil, API, indexer, web, and optional PostgreSQL.
- Add CI for JavaScript tests, frontend builds, Foundry tests, linting, security scans, and migration checks.
- Add production deployment scripts for a configured network such as Base Sepolia, with explicit RPC, wallet, storage, and notification configuration.
- Add monitoring, backups, operational runbooks, multisig/admin-key readiness, and incident recovery procedures.
- Finish the `apps/`, `packages/`, and `services/` monorepo migration without breaking the current local commands.

## Important implementation risks

- The local development wallet contains deterministic Anvil private keys in frontend code. This is acceptable only for local mode and must be impossible to use in a production build.
- The local storage provider is useful for development, but local files are not durable or horizontally scalable storage.
- The current API is a lightweight Node HTTP server, not yet a hardened public API.
- Contract deployment is local and deterministic, but contracts have not been independently audited.
- The Patron Edition integration now exists in the local flow, but its token model, per-lot supply rules, and lifecycle policy need product and security decisions.
- Current CSS and component organization still feel like an early product shell; the application needs a deeper information architecture and interaction pass after correctness is stabilized.

## Intended provider swaps

Business logic should continue to depend on interfaces, with these implementation substitutions later:

| Local development | Production option |
| --- | --- |
| Anvil | Base Sepolia or another configured EVM network |
| Local SQLite | Local PostgreSQL or managed PostgreSQL |
| Local uploads | Pinata/IPFS or another configured storage provider |
| Local notification logging | Resend or another mail provider |
| Database search | PostgreSQL search or dedicated search provider |
| Deterministic local wallet | Injected wallet or wallet-connect flow |

## Bottom line

Patronage currently contains a working, verifiable local vertical slice and the core pieces needed to extend it. It does not yet satisfy the full acceptance test because clean cold-start reliability, restart/rebuild verification, security hardening, complete auction edge-case coverage, fake-fixture cleanup, and the broader product surface are still outstanding.

The next engineering priority is to make the local acceptance test repeatable from a clean start, then close the P0 items before expanding product features.
