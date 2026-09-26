# Changelog

All notable changes to the Patronage platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-07-30

### Production Audit Complete (12/12 Issues Fixed)

#### Critical Severity
- **CRIT-1 (PatronEdition.sol)**: Added `withdraw(address payable to)` restricted to `DEFAULT_ADMIN_ROLE` to allow claiming funds collected during Patron Edition mints (`2026-07-30`).
- **CRIT-2, CRIT-3, CRIT-4 (AuctionHouse.sol)**: Refactored settlement payment mechanism to use safe payments with pull-refund fallback (`refundable` mapping), validated `royaltyReceiver != address(0)`, and capped protocol fees + royalties to prevent Solidity underflows during auction settlement (`2026-07-30`).

#### High Severity
- **HIGH-1 (ArtistFactory.sol & ArtworkNFT.sol)**: Configured artist address (`msg.sender`) as the EIP-2981 royalty receiver in cloned contracts (`2026-07-30`).
- **HIGH-2 (api/server.mjs)**: Secured local file storage upload pipeline by enforcing strict MIME type validation (PNG/JPEG/WEBP/GIF/SVG), 10MB payload size limit, and path traversal sanitization on file paths (`2026-07-30`).

#### Medium Severity
- **MED-1 (ArtworkNFT.sol)**: Added dynamic `name()` and `symbol()` initialization for custom artist collections (`2026-07-30`).
- **MED-2 (services/indexer/index.mjs)**: Wrapped all indexer state updates in atomic `prisma.$transaction([])` blocks and added `LotCancelled` event handling to prevent state corruption on crashes (`2026-07-30`).
- **MED-3 (AuctionHouse.sol)**: Added explicit revert (`DirectETHNotAllowed()`) to plain fallback `receive()` function to reject untracked direct ETH transfers (`2026-07-30`).

#### Low Severity
- **LOW-1 (AuctionHouse.sol)**: Gas optimization via storage packing of `Lot` struct fields, saving 2 storage slots per lot (`2026-07-30`).
- **LOW-2 (src/config/index.mjs)**: Created central configuration loader for RPC URLs, API ports, upload directory paths, and database URLs (`2026-07-30`).
- **LOW-3 (AuctionHouse.sol)**: Standardized anti-snipe extension window logic (`2026-07-30`).

### Added
- **BLK-04 (src/providers/storage.mjs)**: Integrated Pinata IPFS Storage Provider adapter (`PinataStorageProvider`) with dynamic fallback to `LocalStorageProvider` for zero-cloud local development (`2026-07-30`).
- **BLK-02 (src/auth/siwe.mjs & api/server.mjs)**: Integrated EIP-4361 Sign-In With Ethereum (SIWE) authentication module supporting cryptographic nonce generation, single-use replay protection, message formatting, and Viem signature verification (`2026-07-30`).
- Created `docs/production-audit.md` as single source of truth audit document.
- Created `docs/SECURITY.md` detailing threat models, trust boundaries, and fund flows.
- Created `docs/ARCHITECTURE.md` detailing system architecture, contract layout, and sequence diagrams.
- Created master test suite `scripts/test-final-suite.mjs` verifying all contract, security, indexer, upload, SIWE auth, and IPFS storage provider fixes.
