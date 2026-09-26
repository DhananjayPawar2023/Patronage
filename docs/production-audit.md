# Patronage Internal Engineering Vulnerability Tracker

> [!IMPORTANT]
> **SCOPE & NATURE OF THIS DOCUMENT:**
> This document tracks the resolution of 12 internal engineering vulnerabilities identified and resolved during platform development.
> **This is an internal development tracker, NOT an independent third-party smart contract audit.**
> Prior to handling real economic value on mainnet, the standalone package in `auditor-pack/` must be submitted to an external audit firm (e.g., OpenZeppelin, Trail of Bits, Spearbit).

---

## Audit Summary

| Severity | Total | Completed | Pending |
| :--- | :--- | :--- | :--- |
| **Critical** | 4 | 4 | 0 |
| **High** | 2 | 2 | 0 |
| **Medium** | 3 | 3 | 0 |
| **Low** | 3 | 3 | 0 |
| **Total** | **12** | **12** | **0** |

---

## Detailed Audit Issues

### CRIT-1: Trapped Patron Edition Mint Funds
- **Severity**: Critical
- **Description**: `PatronEdition.sol` accepts ETH payments during `mint()` but provided no `withdraw()` function for administrators or treasury.
- **Affected Files**: [PatronEdition.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/PatronEdition.sol)
- **Root Cause**: Missing withdrawal interface for collected ETH balance.
- **Security Impact**: ETH sent to mint Patron Edition tokens was permanently locked in contract address.
- **Implementation Status**: Completed
- **Tests**: `contracts/test/PatronEdition.t.sol` & `scripts/test-patron-withdraw.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Added `withdraw(address payable to)` restricted to `DEFAULT_ADMIN_ROLE`.

---

### CRIT-2: Unhandled Zero Royalty Receiver & Reverting ETH Transfers in `AuctionHouse.settle()`
- **Severity**: Critical
- **Description**: If `IERC2981.royaltyInfo` returns `address(0)` as the receiver or if the royalty receiver contract rejects ETH, `_pay()` reverts, locking the entire auction settlement.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L66-L72)
- **Root Cause**: `settle()` called `_pay()` without checking `royaltyReceiver != address(0)` and without handling transfer failures.
- **Security Impact**: Sellers and winning bidders have funds/NFTs permanently locked in `AuctionHouse`.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Refactored `_safePay()` to push ETH or credit `refundable[recipient]` mapping if transfer fails, and added `royaltyReceiver != address(0)` validation.

---

### CRIT-3: Contract Winner / Receiver Revert Lockout in `AuctionHouse.settle()`
- **Severity**: Critical
- **Description**: `settle()` uses `IERC721.safeTransferFrom` to send the NFT to `lot.bidder`. If seller or winner payment fails, settlements could be DOSed.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L69)
- **Root Cause**: Direct push payment failures in settlement transaction.
- **Security Impact**: Uncooperative sellers or royalty receivers could block settlement.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Wrapped all settlement payments in pull-payment fallback (`refundable` mapping).

---

### CRIT-4: Underflow in Fee Calculations when Protocol Fee + Royalty Exceeds Highest Bid
- **Severity**: Critical
- **Description**: In `AuctionHouse.settle()`, `sellerAmount = lot.highestBid - protocolFee - royalty` can underflow if `protocolFee + royalty > lot.highestBid`.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L68)
- **Root Cause**: Uncapped royalty or protocol fee calculation resulting in underflow revert in Solidity 0.8+.
- **Security Impact**: Auction settlement reverts permanently if royalty configuration exceeds remaining bid percentage.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Fee capping logic added: caps `protocolFee + royalty` to `lot.highestBid` to strictly prevent underflows.

---

### HIGH-1: Artist Royalty Receiver Default Traps Funds in `ArtistFactory`
- **Severity**: High
- **Description**: `ArtistFactory.sol` initialized `ArtworkNFT` collections with `artistTreasury()` returning `address(this)`. `ArtistFactory` has no withdrawal function for received ETH royalties.
- **Affected Files**: [ArtistFactory.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/ArtistFactory.sol#L26-L31), [ArtworkNFT.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/ArtworkNFT.sol)
- **Root Cause**: `artistTreasury()` returned `address(this)` instead of the artist address (`msg.sender`).
- **Security Impact**: Artist secondary sale royalties accumulated in `ArtistFactory` without a way to claim them.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-artist-factory.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Updated `createCollection` to pass `msg.sender` (artist) directly as `royaltyReceiver`.

---

### HIGH-2: Unrestricted Upload Endpoint & Path Traversal Vulnerability
- **Severity**: High
- **Description**: `api/server.mjs` upload handler did not sanitize filenames, enforce file size limits, or validate MIME types.
- **Affected Files**: [api/server.mjs](file:///c:/Users/Umesh/Desktop/superrare/api/server.mjs)
- **Root Cause**: Unsanitized local storage upload pipeline.
- **Security Impact**: Potential arbitrary file write, DoS via memory exhaustion, or path traversal attacks.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-upload-security.mjs`
- **Verified**: Yes (Passed API integration execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Added strict MIME type whitelist (PNG/JPEG/WEBP/GIF/SVG), 10MB payload size limit, and `path.basename` path traversal sanitization.

---

### MED-1: Unused Parameters in `ArtistFactory.createCollection()`
- **Severity**: Medium
- **Description**: `createCollection(string calldata name_, string calldata symbol_)` accepts name and symbol but ignored them when initializing `ArtworkNFT`.
- **Affected Files**: [ArtistFactory.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/ArtistFactory.sol#L23-L28), [ArtworkNFT.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/ArtworkNFT.sol)
- **Root Cause**: `ArtworkNFT.initialize()` did not accept name and symbol, leaving all cloned collections with default names.
- **Security Impact**: Inconsistent collection name/symbol on-chain for cloned artist collections.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-artist-factory.mjs`
- **Verified**: Yes (Passed E2E local EVM execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Added `_customName` and `_customSymbol` state variables and overridden `name()`/`symbol()` getters in `ArtworkNFT.sol`.

---

### MED-2: Indexer Block Progress & Re-org Handling
- **Severity**: Medium
- **Description**: `services/indexer/index.mjs` handled events without transactional atomicity for block progress state and entity updates.
- **Affected Files**: [services/indexer/index.mjs](file:///c:/Users/Umesh/Desktop/superrare/services/indexer/index.mjs)
- **Root Cause**: Non-transactional DB operations in event handling loop.
- **Security Impact**: Indexer state desynchronization or partial writes on crash / restart.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-indexer-atomicity.mjs`
- **Verified**: Yes (Passed integration execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Wrapped all indexer state updates (entity creation, event logs, notifications) in atomic `prisma.$transaction([])` calls, and added `LotCancelled` event handling.

---

### MED-3: Unprotected ETH Fallback in `AuctionHouse`
- **Severity**: Medium
- **Description**: `AuctionHouse` defined `receive() external payable {}` which accepted untracked direct ETH transfers.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L136)
- **Root Cause**: Plain fallback function without deposit validation.
- **Security Impact**: Direct ETH transfers get trapped or corrupt accounting expectations.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes (Passed contract execution)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Updated `receive()` to explicitly revert with `DirectETHNotAllowed()`.

---

### LOW-1: Gas Optimization on Custom Errors & Struct Packings
- **Severity**: Low
- **Description**: Struct fields in `AuctionHouse.Lot` were unoptimized in storage layout.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L20-L31)
- **Root Cause**: Unpacked struct storage layout.
- **Security Impact**: Non-critical higher gas fees on creation and bidding.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes (Passed gas check)
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Reordered fields in `Lot` struct (`seller`, `start`, `settled`, `cancelled`, `nft`, `end`, `bidder`, `tokenId`, `reserve`, `minIncrement`, `highestBid`) saving 2 storage slots per lot.

---

### LOW-2: Hardcoded Configs & Network Fallbacks
- **Severity**: Low
- **Description**: Hardcoded URLs and ports across scripts and API server instead of central configuration loader.
- **Affected Files**: [src/config/index.mjs](file:///c:/Users/Umesh/Desktop/superrare/src/config/index.mjs), [api/server.mjs](file:///c:/Users/Umesh/Desktop/superrare/api/server.mjs)
- **Root Cause**: Hardcoded configuration strings.
- **Security Impact**: Configuration friction when switching ports or environments.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-final-suite.mjs`
- **Verified**: Yes
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Created centralized configuration loader `src/config/index.mjs`.

---

### LOW-3: Anti-Snipe Extension Window Edge Cases
- **Severity**: Low
- **Description**: `antiSnipeWindow` extension formula documentation and runtime edge cases.
- **Affected Files**: [AuctionHouse.sol](file:///c:/Users/Umesh/Desktop/superrare/contracts/src/AuctionHouse.sol#L52)
- **Root Cause**: Overwrite timestamp calculation near auction end.
- **Security Impact**: Dynamic auction ending time variation.
- **Implementation Status**: Completed
- **Tests**: `scripts/test-settlement-security.mjs`
- **Verified**: Yes
- **Documentation Updated**: Yes
- **Date Fixed**: 2026-07-30
- **Engineer Notes**: Verified anti-snipe extension formula guarantees bidders `antiSnipeWindow` seconds from the timestamp of any late bid.
