# 📦 Patronage Smart Contract External Audit Handoff Brief

> **Target Audience:** Independent Smart Contract Security Reviewer / Audit Firm  
> **Commit Hash / Scope Date:** 2026-09-26  
> **Compiler:** Solidity `^0.8.24` (EVM target: Cancun / Paris)  
> **Framework:** Foundry (`forge-std`)  
> **Dependencies:** OpenZeppelin Contracts `v5.2.0`  

---

## 1. Scope of Audit

| Contract | File Path | SLOC | Purpose |
| :--- | :--- | :--- | :--- |
| **`AuctionHouse.sol`** | `src/AuctionHouse.sol` | ~224 | Core timed English auction, instant buy-now, pull-over-push escrow (`refundable[account]`), and anti-snipe extensions. |
| **`ArtworkNFT.sol`** | `src/ArtworkNFT.sol` | ~59 | 1/1 creator collection supporting sequential minting (`nextTokenId++`) and EIP-2981 royalty routing. |
| **`PatronEdition.sol`** | `src/PatronEdition.sol` | ~75 | Soulbound / patron edition minting during active lots, with admin withdrawal. |
| **`ArtistFactory.sol`** | `src/ArtistFactory.sol` | ~45 | Minimal-proxy clone factory for sovereign artist collections. |
| **`Treasury.sol`** | `src/Treasury.sol` | ~25 | Protocol fee receiver and non-custodial treasury. |
| **`PlatformRegistry.sol`** | `src/PlatformRegistry.sol` | ~30 | Access-controlled platform address registry. |

---

## 2. Core Architectural Decisions & Invariants

1. **Pull-Over-Push Escrow**:
   - Outbid funds and failed payouts are never sent via push `.call{value: ...}("")`.
   - Instead, funds are credited to `refundable[account]`.
   - The user pulls funds via `withdrawRefund()`.
   - **Invariant**: `address(this).balance >= sum(refundable)`.
   - **Critical Note**: `withdrawRefund()` has **no `whenNotPaused` modifier**. Users can ALWAYS withdraw refunds even if the contract is paused by the operator.

2. **Role & Governance Separation (Fast-Path vs. Timelock)**:
   - `OPERATOR_ROLE` holds emergency `pause()` and `unpause()`. This is callable immediately (fast path).
   - `DEFAULT_ADMIN_ROLE` controls `setProtocolFee` and `setProtocolTreasury`. In production, this role is held by a 48-hour `TimelockController`.
   - Verified in test: `test/TimelockAndPause.t.sol`.

3. **Anti-Snipe Protection**:
   - Bids placed within `antiSnipeWindow` (default 900 seconds / 15 minutes) of `lot.end` dynamically push `lot.end = block.timestamp + antiSnipeWindow`.

4. **Sequential Minting**:
   - `nextTokenId` starts at 1 and increments per token.

---

## 3. Prior Internal Audit Findings & Remediation History

The following items were identified and remediated internally prior to this external handoff:

1. **Reentrancy on Settlement**: Solved via `refundable[account]` + OpenZeppelin `ReentrancyGuard` on all state-changing external functions.
2. **Reserve Price Bypass**: Added strict checks `if (msg.value < lot.reservePrice) revert ReserveNotMet();`.
3. **Snipe Griefing**: Added 15-minute anti-snipe extension.
4. **Clone Re-initialization**: Added `initialized` boolean lock to `ArtworkNFT.initialize()`.
5. **Sequential Token ID**: Upgraded single-edition NFT to dynamic sequential token ID increment.

---

## 4. How to Run the Automated Test Suite

Prerequisites: Install Foundry (`forge`, `cast`, `anvil`).

```bash
# Run all unit, invariant, and timelock tests with verbosity
forge test -vvv

# Run fuzz tests with 10,000 runs
forge test --fuzz-runs 10000

# Generate test coverage report
forge coverage
```

---

*Prepared for external security review. Note: Internal testing does not replace formal third-party audit.*
