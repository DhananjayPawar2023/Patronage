# Patronage Project Status & Verified Engineering Ledger

This document reflects the verified state of the Patronage codebase based on direct test executions, static audits, and runtime proofs.

---

## 1. Verified Real Systems (`DONE`)

* **Smart Contracts & Execution:**
  - Real Solidity 0.8.24 contracts: `AuctionHouse`, `ArtworkNFT`, `ArtistFactory`, `PatronEdition`, `PlatformRegistry`, `Treasury`, `PatronTimelock`.
  - Nonce-protected, pull-over-push escrow accounting (`withdrawRefund`) preventing reentrancy/DoS.
  - Anti-snipe time extension (configurable, default 300s).
  - Sovereign artist clones (EIP-1167) with on-chain EIP-2981 royalty enforcement.
  - **43/43 passing Foundry tests** (`tools/foundry/forge.exe test --root contracts`), including an invariant fuzz suite executing 128,000 calls across state transitions and dedicated property tests (`AuctionAccountingInvariant.t.sol`).
  - **EIP-1167 Implementation Lockout:** Base `ArtworkNFT` implementation contract sets `initialized = true` in constructor, preventing any attacker from initializing or establishing state on the implementation contract.
  - **EIP-712 Voucher Expiration:** Added `deadline` to `NFTVoucher` and `VOUCHER_TYPEHASH`, rejecting expired or zero-deadline vouchers on-chain and in API.
  - Fast-path `OPERATOR_ROLE` emergency pause split from 48-hour `TimelockController` fee/parameter updates (verified in `contracts/test/TimelockAndPause.t.sol`).

* **Governance & Deployment Wiring:**
  - `scripts/deploy.mjs` instantiates OpenZeppelin `PatronTimelock` (48-hour delay = 172,800s), grants `DEFAULT_ADMIN_ROLE` on `AuctionHouse` to the timelock, grants `OPERATOR_ROLE` to the designated guardian, registers `TIMELOCK` in `PlatformRegistry`, and records contracts in `contracts/deployments/{chainId}.json`.
  - **Timelock Executor Standard Verified:** Manifest explicitly records `executorPolicy: 'OpenExecutionAfterDelay'`. In OpenZeppelin's `TimelockController`, `executors: ["0x0000000000000000000000000000000000000000"]` deliberately allows permissionless execution by any party once the 48-hour timelock delay has elapsed, while proposal creation remains strictly gated by `PROPOSER_ROLE`.
  - **Safe Multi-Sig Guard:** Remote/mainnet deploys require `TIMELOCK_PROPOSERS` with multi-sig co-signers; local sandbox flags `isMultisigConfigured: false` and `migrationPending: true`.

* **Backend Security, RBAC & Sanctions Automation:**
  - **P0 SIWE Nonce Concurrency & Atomicity:** Implemented atomic single-statement nonce consumption (`DELETE FROM "SiweNonce" WHERE "nonce" = ? AND "expiresAt" > ?`) returning affected row count, eliminating race conditions under concurrent requests. Verified with 10-way concurrency test (`scripts/test-siwe-concurrency.mjs`: exactly 1 accepted, 9 rejected).
  - **P0 Hardened SIWE Message Validation:** Strict verification of domain against request host/whitelist, URI against origin, chain ID against active chain, freshness within 10m, and strict rejection of notBefore/expiration violations.
  - **P1 Storage & File Upload Security:** Magic-bytes verification (PNG, JPEG, GIF, WEBP, SVG), path traversal (`../`, `..\`) protection, filename sanitization, content hashing, and size limit enforcement (`scripts/test-upload-security.mjs`).
  - **P1 API Hardening & Security Headers:** HSTS, Content-Security-Policy, Permissions-Policy, X-Content-Type-Options, rate limiting, and CORS restricted to configured trusted origins (`scripts/test-api-security.mjs`).
  - Role-Based Access Control: `/api/admin/artists/*` and `/api/admin/sanctions/*` restricted to configured `ADMIN_ADDRESSES` (401 unauth, 403 non-admin).
  - Moderation protection: `POST /api/moderation/delist` and `GET /api/moderation/delisted` restricted to `ADMIN_ADDRESSES` / `MODERATOR_ADDRESSES`.
  - Durable SIWE Authentication: Sessions and single-use nonces stored in Prisma database (`Session` and `SiweNonce` tables), persisting across API server restarts.
  - **Automated Session & Nonce Maintenance Pruning:** `api/server.mjs` runs `pruneExpiredSessionsAndNonces()` on boot and via an hourly recurring background timer (`SESSION_PRUNE_INTERVAL_MS = 1h`), purging expired abandoned tokens, and exposes `POST /api/admin/sessions/prune` and `GET /api/admin/sessions/status`.
  - EIP-4361 Message Validation: Strict verification of domain against request host, URI against origin, chain ID against active chain, and issued-at timestamp freshness.
  - **Automated Sanctions Sync & Recurring Scheduler:** `api/server.mjs` runs a background scheduler (`SANCTIONS_SYNC_INTERVAL_MS = 24h`) executing automated updates against the OFAC SDN dataset, exposes `GET /api/admin/sanctions/status` and `POST /api/admin/sanctions/sync` (admin-gated), persists to `src/auth/ofac-sanctions-cache.json`, and reports metadata including sync cadence and source qualification.
  - **Cross-Database SQL Standardized (SQLite to PostgreSQL):** All parameterized raw SQL queries across the entire repository use Prisma tagged-template literals (`prisma.$executeRaw` and `prisma.$queryRaw`) with zero raw `?` or `$1` string interpolations. Prisma compiles variables automatically into dialect-appropriate parameter bindings, ensuring zero code changes or runtime syntax errors when transitioning to PostgreSQL (Supabase / Neon).
  - Verified via `scripts/test-rbac-and-durable-auth.mjs` (5/5 tests passing), `scripts/test-sanctions-scheduler.mjs` (4/4 tests passing), and `scripts/test-session-pruning.mjs` (4/4 tests passing).

* **Sanitization & Zero-Cloud Local Mode:**
  - Full-repository private key audit (`scripts/verify-backend-and-full-repo.mjs`): 0 Anvil keys/mnemonics in `api/`, `services/`, `dist/`, or root configs.
  - Frontend `src/main.jsx` tree-shakes test accounts in production builds (`dist/` contains 0 keys and 0 source maps).
  - Zero-cloud local mode: Coinbase spot price API and LlamaRPC ENS client silenced when operating in local development mode (`isDevMode`).
  - Upload Hygiene: Stale test artifacts purged from `uploads/`.

* **Durable Event Indexer, Reorg Recovery & Wipe-and-Rebuild:**
  - **Authoritative Default Indexer (`services/indexer/vendored-adapter.mjs`):** The durable vendored indexer powered by `@1001-digital/simple-indexer` with native SQLite disk storage (`data/vendored-indexer.db`) is now the default runtime indexer daemon launched by `npm run indexer` and `pnpm dev`.
  - **Full Prisma State Reconciliation:** Complete two-tier synchronization reconciling 100% of blockchain state into Prisma relational models: all auction `Lots`, bids with outbid notification events, open `PatronMints`, settlements with seller/winner notifications, raw audit logs (`IndexedEvent`), and responsive metadata resolution (`local://` and HTTP/IPFS).
  - **Race-Condition-Proof Reorg and Rebuild Loop:** Guaranteed atomic wipe-and-replay detection ensuring background daemons immediately detect manual database resets (`lastProcessedBlock='0'` or `status='rebuilding'`) or block hash divergence at checkpoint height, without trailing `onStatus` race conditions overwriting rebuild requests.
  - **True Reorg Rollback & Live Replay Verified:** Step 23 of `scripts/test-master-acceptance-flow.mjs` and `scripts/test-indexer-reorg-rollback.mjs` both test the complete reorg path through the live background indexer daemon. The test: (1) injects a divergent ghost lot that never existed on-chain, (2) corrupts the checkpoint hash, (3) waits for the daemon to detect divergence, atomically delete all derived rows, reset checkpoint to `0`, and replay all historical events, and (4) asserts rebuilt lot fields match pre-reorg state field-for-field.
  - **True Chain-Level Reorg via Real Fork (`scripts/test-real-chain-reorg.mjs`):** Uses Anvil's `evm_snapshot` + `evm_setNextBlockTimestamp` + `evm_revert` to produce a genuine chain fork — Fork A (block N+1, ts+50) and Fork B (block N+1, ts+100) at the **same block number with genuinely different SHA3 block hashes** (confirmed: `0x56e9aba4...` ≠ `0xe264d8d0...`). Checkpoint is atomically poisoned to Fork A's hash after Fork B is already canonical. Background daemon autonomously detects hash mismatch, wipes derived state, replays from genesis, and heals checkpoint to Fork B's hash. This is the only test in the suite that exercises a real chain fork — not a manipulated DB field.
  - **Process Kill/Restart Durability (`scripts/test-indexer-kill-restart.mjs`):** Spawns a fresh indexer child process, mines 10 blocks, waits for checkpoint to advance, sends `SIGKILL` (hard kill, no graceful shutdown), then respawns. Verifies: (1) restarted process resumes from saved checkpoint block (not from 0), (2) fully heals to `status='healthy'`, (3) zero `(transactionHash, logIndex)` duplicate `IndexedEvent` rows despite two processes having run on the same block range.
  - **Wipe-and-Rebuild from Genesis Verified:** Step 22 in `scripts/test-master-acceptance-flow.mjs` atomically wipes all derived tables (`Lot`, `Bid`, `PatronMint`, `IndexedEvent`), resets checkpoint block to 0, lets the indexer replay historical blocks from block zero, and strictly asserts that the rebuilt lot fields match pre-wipe state field-for-field (`status='settled'`, `highestBid='0.2 ETH'`).
  - **Vendored Indexer Durable SQLite Storage (`scripts/test-vendored-indexer-durability.mjs`):** Enhanced the `@1001-digital/simple-indexer` package with native `node:sqlite` storage (with `better-sqlite3` fallback). Persists raw events, user tables, and cursors to disk (`data/vendored-indexer.db`), resuming on subsequent boots without re-fetching historical blocks.
  - **PostgreSQL Schema & SQL Dialect Portability (`scripts/test-postgresql-compatibility.mjs`):** Automatically validates the Prisma schema with `provider = "postgresql"`, generates 152 lines of valid PostgreSQL DDL migrations (`TIMESTAMP(3)`, `TEXT`, primary keys, composite unique constraints), and statically audits all 19 raw repository queries to guarantee double-quoted identifiers and tagged template bindings with zero SQLite-specific `?` placeholders.

* **Museum-Grade Web3 Frontend & Design System (Goal 2 `DONE`):**
  - **Editorial Typography:** Imported Google Fonts (`Cinzel` display serif headers, `Plus Jakarta Sans` body typography, and `JetBrains Mono` / `DM Mono` monospace numerals and blockchain hashes).
  - **Atmospheric Dark Palette & Glassmorphism:** Deep obsidian canvas (`#09090d`) with ambient radial mesh lighting, frosted glass cards (`backdrop-filter: blur(16px)`), micro-borders (`rgba(255,255,255,0.08)`), and luxury gold (`#f5a623`) / coral (`#ff5c47`) glow highlights on interactive states.
  - **Live Auction State Visualization:** Glowing status badges with animated pulse indicators (`LIVE AUCTION` in emerald, `SETTLED` in royal purple, `BUY NOW` in cyan), anti-snipe 15-minute shield pills, and synchronized countdown timers.
  - **Interactive Museum Viewing Room & Lightbox:** Split-column lot modal with high-res cinema lightbox zoom, copyable contract specification pills, interactive provenance milestone timeline (minted, listed, bid, settled), on-chain bid ledger, and interactive offers & counter-offers negotiation ledger.
  - **Multi-Wallet & EIP-6963 Injected Signer Support:** First-class connector modal supporting MetaMask, Rabby, Coinbase Wallet, Browser Injected (EIP-6963), and WalletConnect v2 pairing URI modal alongside local testing dev keys. Automatically synchronizes network switching and account changes across EVM chains.
  - **Production Bundle Hygiene:** Fully optimized and tree-shaken with Vite (`dist/` built in <700ms, zero private keys, zero sourcemaps).

* **On-Chain Escrowed Offer & Counter-Offer System (`DONE`):**
  - **Smart Contract Escrow:** `AuctionHouse.sol` implements `makeOffer(nft, tokenId)` payable, `cancelOffer(nft, tokenId)`, `counterOffer(nft, tokenId, buyer, amount)`, and `acceptOffer(nft, tokenId, buyer)`.
  - **Sovereign Negotiation:** Collectors escrow ETH offers below reserve on live auctions or unauctioned NFTs. Sellers can counter-offer with desired pricing or accept the offer directly.
  - **Bid-Precedence Protection:** If an auction receives active bids reaching or exceeding reserve, `acceptOffer` reverts with `BidPrecedence()`, guaranteeing auction finality for highest bidders.
  - **Pull-Over-Push Refund Security:** Cancelled or superseded offers automatically route escrowed ETH to `refundable[buyer]` pull-vaults, completely immune to reentrancy attacks or malicious receiver contracts.
  - **Durable Indexer & API:** Indexer captures `OfferMade`, `OfferCancelled`, `CounterOfferMade`, and `OfferAccepted` events, persisting into Prisma `Offer` records. Exposed via `GET /api/offers?chainId=&nftAddress=&tokenId=`.

* **EIP-712 Gasless Lazy Minting System (`DONE`):**
  - **Zero-Gas Artist Onboarding:** Artists create and sign cryptographic `NFTVoucher` structured data off-chain paying zero gas.
  - **Minimal Proxy EIP-712 Domain Dynamic Separator:** `ArtworkNFT.sol` dynamically derives `domainSeparator()` based on `block.chainid` and `address(this)`, fully protecting EIP-1167 minimal proxy clones against cross-chain and per-contract signature replays.
  - **Collector-Funded Mint & Claim:** `mintWithVoucher(voucher, signature)` is payable; collectors execute the transaction on-chain, paying gas and mint price. The smart contract validates ECDSA signature against the collection's creator, mints the 1/1 NFT directly to the collector, enforces anti-replay via `redeemedVouchers` digest mapping, and forwards 100% of the purchase price to the artist.
  - **Marketplace API & UI Integration:** Artists toggle between "Timed English Auction" and "Gasless Lazy Mint" in `CreateDropModal`. Active vouchers are stored in `LazyVoucher` table via `POST /api/vouchers` and rendered in the gallery feed with `⚡ LAZY MINT` badges, filtering, and dedicated claim modals.

* **Master Pre-Flight Pipeline:**
  - All 21/21 automated verification pipelines pass cleanly in `scripts/verify-all.mjs` (including 43/43 Foundry tests with 128k fuzz calls, P0 SIWE concurrency, P1 storage security, P1 API security, Anvil forks, indexer kill/restart, master 25-step acceptance flow, PostgreSQL dialect validation, and the complete EIP-712 lazy mint & on-chain offers flow).

---

## 2. In Progress (`IN PROGRESS`)

* *None currently in development loop; all target technical tasks for Goal 1 are complete.*

---

## 3. Human & External Blockers (`BLOCKED-PENDING-HUMAN`)

These items cannot be resolved by code alone and require real-world human decisions, credentials, or formal counsel:

1. **Persistent PostgreSQL Database:** Requires real Supabase or Neon `DATABASE_URL` (local development operates on durable SQLite/Prisma).
2. **Persistent Cloud Hosting:** Requires Railway or Fly.io deployment token.
3. **Decentralized Storage:** Requires funded Pinata JWT or Arweave keyfile.
4. **Base Sepolia Staging:** Requires testnet faucet funds and deployer key.
5. **3rd-Party Smart Contract Audit:** Independent engagement of `auditor-pack/` with a professional security firm.
6. **Multi-Sig Safe Co-Signers:** 3-of-5 hardware wallet addresses for timelock proposer/executor roles.
7. **Legal & Compliance Determination:**
   - Formal legal opinion on Indian Section 194S (1% TDS), Section 115BBH (30% VDA flat tax), and FIU-IND platform registration.
   - Compliance determination on whether automated pre-screening via community-maintained SDN mirror (`ultrasoundmoney`) meets regulatory standards or if a direct US Treasury XML ingestion worker or certified compliance oracle (e.g. Chainalysis / TRM Labs API) is mandatory.
