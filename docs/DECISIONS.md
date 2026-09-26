# Patronage Architectural Decision Records (ADR)

---

## ADR-001: Local-First Provider Pattern
- **Status**: Accepted
- **Context**: Need seamless local offline development without cloud API key dependencies while preserving path to production cloud providers.
- **Decision**: Implement all subsystems (Storage, Indexer, Database, Wallet) behind clean Provider Interface classes (`LocalStorageProvider`, `ViemIndexer`, `PrismaSQLite`).
- **Consequences**: Developers can run full application offline on localhost. Swapping to Pinata or PostgreSQL requires only updating provider implementation classes.

## ADR-002: Pull Payments for Escrow Refunds
- **Status**: Accepted
- **Context**: Direct push payments (`.call{value: amount}`) during outbid or settlement can cause transaction reverts if recipient is a contract rejecting ETH.
- **Decision**: Use pull payment pattern (`refundable[recipient] += amount`) for outbid refunds and settlement fallbacks via `_safePay()`.
- **Consequences**: Completely eliminates settlement denial-of-service attack vectors.

## ADR-003: Atomic Database Transactions in Event Indexer
- **Status**: Accepted
- **Context**: Non-transactional DB updates in log listener risk state corruption if indexer process crashes midway.
- **Decision**: Wrap all indexed entity updates and event log markers in `prisma.$transaction([])`.
- **Consequences**: Guarantees atomic database consistency and idempotent re-indexing.

## ADR-004: Dual-Axis Governance (On-Chain Timelock vs Off-Chain Operational RBAC)
- **Status**: Accepted
- **Context**: On-chain governance requires high-friction security (3-of-5 Gnosis Safe + 48-hour timelock) to protect treasury funds, fees, and contract parameters. However, day-to-day backend operations (artist application approvals, DMCA takedowns, sanctions list cache refreshes) require low-latency execution without waiting 48 hours or gathering 3 multisig signatures per moderation action.
- **Decision**: Decouple governance into two distinct axes:
  1. *On-Chain Governance Axis*: Controlled exclusively by `PatronTimelock` (48h delay) with `TIMELOCK_PROPOSERS` (Gnosis Safe). Fast-path emergency pause is granted to an operational `OPERATOR_ROLE` (Guardian), but fee/parameter changes strictly require timelock clearance.
  2. *Off-Chain Operational Axis*: Managed via environment-configured multi-address lists (`ADMIN_ADDRESSES` and `MODERATOR_ADDRESSES`). Each operator authenticates individually using SIWE with their own hardware wallet. No shared private key exists; operations are audited with the signer's public address.
- **Consequences**: High-value funds and protocol rules are immune to single-key compromise. Day-to-day operations remain responsive. A compromised operational key can at most alter database moderation status, never contract funds or parameters.

## ADR-005: EIP-1271 Support for Contract Wallets in SIWE Authentication
- **Status**: Accepted
- **Context**: Smart contract accounts (e.g. Gnosis Safe, Argent, ERC-4337 smart accounts) cannot sign messages using standard ECDSA `personal_sign` because they possess no private keys.
- **Decision**: Pass the Viem `publicClient` to `verifySiweSignature`. When a signer address contains deployed contract bytecode, Viem automatically evaluates the standard EIP-1271 `isValidSignature(hash, signature)` method on-chain.
- **Consequences**: Enables Gnosis Safe and multisig accounts to authenticate directly to the API backend if an organization elects to use multisig signing for administrative endpoints.

## ADR-006: Immediate Boot-Time Ingestion with Periodic Fallback for Sanctions Screening
- **Status**: Accepted
- **Context**: Ephemeral cloud container platforms (Fly.io, Railway, Render) frequently spin down or restart processes. If a sanctions sync only triggered after a 24-hour interval, restarts would prevent the list from ever refreshing.
- **Decision**: Trigger an immediate, non-blocking `syncSanctionsFeed()` invocation upon server initialization (`server.listen`), followed by an unreffed 24-hour recurring timer (`setInterval`). If the external network request fails, fall back gracefully to the persisted local offline cache (`src/auth/ofac-sanctions-cache.json`).
- **Consequences**: Guarantees up-to-date sanctions lists on boot regardless of process lifecycle, while preventing network timeouts or external downtime from blocking API server startup.

## ADR-007: Periodic SIWE Session & Nonce Maintenance Pruning
- **Status**: Accepted
- **Context**: `Session` and `SiweNonce` tables originally pruned only on read access or explicit user logout. Over time, abandoned nonces and expired sessions accumulate indefinitely, causing unbounded table growth.
- **Decision**: Implement `pruneExpiredSessionsAndNonces()` to execute an atomic `DELETE FROM "Session" WHERE "expiresAt" < now()` and `DELETE FROM "SiweNonce" WHERE "expiresAt" < now()`. Run this maintenance immediately on API server boot, continuously via an hourly background scheduler (`setInterval`), and expose an authenticated `POST /api/admin/sessions/prune` endpoint for on-demand cleanup.
- **Consequences**: Prevents table bloat and memory leaks in both local SQLite and production PostgreSQL environments without requiring external cron dependencies.

## ADR-008: Universal Tagged-Template SQL Standard for SQLite and PostgreSQL
- **Status**: Accepted
- **Context**: In SQLite, parameterized SQL queries historically used `?` placeholders (e.g. `WHERE "token" = ?`), while PostgreSQL's driver requires `$1, $2, ...` positional placeholders. Using `$executeRawUnsafe` or `$queryRawUnsafe` with hardcoded `?` strings would cause immediate syntax or binding failures upon migrating `DATABASE_URL` to PostgreSQL (e.g., Supabase, Neon).
- **Decision**: Standardize all parameterized raw SQL queries across the entire codebase onto Prisma tagged-template literals (`prisma.$executeRaw` and `prisma.$queryRaw`). In tagged templates, interpolated variables (`${value}`) are treated by Prisma as parameters rather than raw string concatenation, and Prisma automatically compiles them into the appropriate dialect placeholder (`?` on SQLite, `$1` on PostgreSQL) while safeguarding against SQL injection.
- **Consequences**: Zero raw-SQL queries use hardcoded dialect-specific parameter placeholders. The backend, tests, and maintenance workers execute identically on SQLite during local development and on PostgreSQL in production.
