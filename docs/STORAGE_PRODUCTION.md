# Storage provider plan

## Current implementation

Local development defaults to `STORAGE_PROVIDER=local`. `LocalStorageProvider` writes files and generated metadata to `uploads/`, returning a local URI and deterministic content digest. This is suitable for Anvil testing only.

Pinata can be selected explicitly with `STORAGE_PROVIDER=pinata` and `PINATA_JWT`. The API sends both artwork bytes and metadata JSON through the `StorageProvider` interface. The Pinata implementation returns `ipfs://<CID>` and a configured gateway URL. If Pinata is selected but credentials are missing or the request fails, the operation fails; it does not silently create local content.

## Production target

The intended production target is a self-hosted Kubo node based on `1001-digital/ipfs.server`, placed behind Caddy. The Kubo admin API must remain private and authenticated. Public access should be read-only through a TLS gateway serving pinned content.

The swap is provider-only:

```text
LocalStorageProvider -> PinataStorageProvider -> KuboStorageProvider
```

Business logic continues to call `put()` and `createMetadata()` and stores the returned CID/URI. No contract, auction, indexer, or frontend business rule should depend on Pinata or Kubo SDK details.

## Required hardening before production

- Verify the returned CID and content after upload.
- Persist upload status, checksum, byte size, and retry state.
- Pin artwork, thumbnails, and metadata separately or as a verifiable DAG.
- Run malware scanning and image decoding in an isolated worker.
- Ensure metadata contains only immutable content references.
- Back up pin manifests and test restore from a clean node.
- Configure gateway cache headers and TLS.
- Never expose the Kubo admin API publicly.

## Open-source reference decisions

`1001-digital/simple-indexer` was reviewed as the desired two-layer event-cache/derived-state design, but it is not available from the npm registry, so it was not installed or falsely claimed as an application dependency. The existing indexer remains the active implementation until the package is vendored from a reviewed commit or the event-cache/mutation-log design is ported with equivalent runtime tests.

`1001-digital/dweb-fetch` was reviewed as the preferred IPFS URL resolver. It was not added because its package publication/installation path was not verified in this environment. The application must use a verified resolver package or an isolated resolver adapter before public IPFS content is rendered.

`1001-digital/ipfs.server` is a deployment reference only in this milestone; it is not deployed.
