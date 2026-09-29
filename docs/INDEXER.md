# Indexer architecture and runtime

## Active implementation

The default local runtime is `services/indexer/vendored-adapter.mjs`, launched by
both `pnpm dev` (`scripts/local-dev.mjs`) and `pnpm indexer`. The older Prisma
indexer remains available as `pnpm indexer:legacy` for comparison and rollback;
it is not the default.

Patronage vendors the MIT-licensed
[`@1001-digital/simple-indexer`](https://github.com/1001-digital/simple-indexer)
source under `packages/simple-indexer/`. Its block/event cache, derived store,
versioned replay, cursors, mutation log, checkpoint hashes, and rollback are
used by the active adapter. The adapter subscribes to the deployed contracts,
writes normalized event-derived records into the vendored store, and
idempotently reconciles lots, bids, Patron Edition mints, settlement state,
and indexed events into Prisma. The API continues to read Prisma.

This currently means there are two representations of derived state. It is an
intentional integration boundary, not a claim that Prisma and the vendored
store are one database. A future refactor can make API reads use the indexer's
store directly and remove Prisma reconciliation after the same acceptance
coverage is retained.

## Local persistence and runtime requirements

The adapter uses `createSqliteStore()` at
`data/vendored-indexer.db` by default. Override the file with
`VENDORED_INDEXER_DB_PATH`. The vendored SQLite implementation uses Node's
built-in `node:sqlite` (`DatabaseSync`), so the local Windows path does not need
`better-sqlite3`, Python, or node-gyp. Node 22.5 or newer is required. The native
SQLite module was removed from the workspace dependency graph so a clean
Windows install does not attempt to compile it.

The store is durable across process restarts and caches raw events separately
from derived rows. PostgreSQL is not used for this event cache; Prisma's
application database remains separately configurable. For Linux/container
deployment, keep the indexer database on a persistent volume and include it in
backup and restore procedures. Do not put this SQLite file on an ephemeral
container filesystem.

## Reconciliation and operational behavior

- Contract event handlers maintain the vendored store and then reconcile the
  corresponding relational rows to Prisma. Reconciliation uses stable chain,
  transaction, and log-index keys so replay is idempotent.
- On startup, the adapter reads deployment artifacts from
  `contracts/deployments/` and connects to `RPC_URL`.
- Checkpoint hashes are compared with the connected chain. A mismatch invokes
  rollback/replay handling; a reset chain with a checkpoint above its current
  head causes derived state to be rebuilt.
- The API's indexer health route reports the active indexer health/status. Do
  not interpret an HTTP health response alone as proof that all historical
  rows match the chain; use the acceptance scripts for that claim.
- The vendored store owns its cached events and cursor. Prisma owns the rows
  consumed by existing API endpoints. A Prisma wipe therefore requires replay
  or reconciliation to repopulate those rows.

## Verification

Use the acceptance scripts in `scripts/` to verify runtime behavior. The
process restart, chain fork/reorg, durable-store restart, and Prisma replay
checks must be run against the active adapter and a non-empty local chain.
Record actual command output and distinguish those checks from the vendored
package unit suite. A passing unit suite does not prove the Prisma adapter or
full marketplace flow.

For a clean local run, use `pnpm install` followed by `pnpm dev`. The local
supervisor starts Anvil when needed, deploys contracts, syncs the application
database, then starts API, indexer, and web processes. SQLite durability is
local infrastructure; no hosted database, RPC, or IPFS provider is required.

## Future provider changes

Keep provider replacement behind the current adapter boundary. Moving metadata
to Pinata/IPFS or the application database to PostgreSQL does not require
changing auction contract logic. Before replacing the local SQLite indexer
cache, preserve cached-event replay, checkpoint validation, mutation rollback,
and the Prisma/API acceptance coverage.
