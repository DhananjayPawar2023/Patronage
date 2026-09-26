# Indexer implementation decision

## Decision

Patronage vendors `@1001-digital/simple-indexer` as source under `packages/simple-indexer/` at pinned commit `8f262661df31d3925f1286231fe653927fb4b4f3`.

The repository is MIT licensed and provides the desired two-layer event-cache/derived-state model, checkpointing, versioned reindex, mutation-log rollback, and status callbacks. The source is built locally into `packages/simple-indexer/dist/`.

The package is not published to npm, so it is not referenced as a registry dependency. The current Patronage runtime indexer remains in `services/indexer/index.mjs` while its Prisma schema is mapped to the vendored store API. This avoids pretending that a direct replacement is integrated when the package’s store model and Patronage’s relational API tables are not compatible without a migration adapter.

This is a safety property because upstream changes cannot silently enter the build. It is also a maintenance cost: future upstream fixes must be reviewed, copied, and tested manually.

## Upstream verification

- Repository: https://github.com/1001-digital/simple-indexer
- Pinned commit: `8f262661df31d3925f1286231fe653927fb4b4f3`
- License: MIT
- Package exports: `dist/index.js` and `dist/sqlite.js`
- Build: executed successfully using the vendored package’s Vite build.

## Actual test result

The vendored package test suite executed 140 tests across 10 files:

- 112 passed.
- 28 SQLite-store tests failed before assertions because `better-sqlite3` could not load a native binding under Node `v24.13.1` on Windows.
- The failure was caused by no prebuilt binary and no usable Python installation for `node-gyp`, not by a reported indexer assertion failure.

The non-native suites, including memory store, IndexedDB store, reorg behavior, event emitters, adaptive ranges, and most integration/reindex tests, passed.

## Required next step for direct runtime adoption

Use a supported Node LTS version with a compatible `better-sqlite3` prebuild, or install the required native build toolchain. Then add an adapter that writes the package’s derived tables into the API’s existing relational schema, or change the API to query the package store. Only after that adapter is runtime-tested should `services/indexer/index.mjs` be replaced.
