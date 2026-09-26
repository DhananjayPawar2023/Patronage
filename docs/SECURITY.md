# Patronage Security & Threat Model Overview

## Threat Model & Trust Boundaries

Patronage is a local-first non-custodial digital art auction platform. Smart contracts govern auction deposits, bid escrowing, royalty distribution, and token minting.

```
       ┌────────────────────────┐
       │     Untrusted User     │
       └───────────┬────────────┘
                   │
                   ▼
       ┌────────────────────────┐
       │   Platform Frontend    │
       └───────────┬────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│        Smart Contract Layer          │
│ ┌──────────────┐    ┌──────────────┐ │
│ │ AuctionHouse │    │ PatronEdition│ │
│ └──────────────┘    └──────────────┘ │
└──────────────────────────────────────┘
```

### Trust Assumptions
1. **Admin / Operator Role**: Admin privileges are held by multisig or designated platform controller to adjust protocol fees and pause execution in emergencies.
2. **Pull Payments**: All outbid refunds use the pull payment pattern (`refundable[account]`) to eliminate reentrancy and denial-of-service risks.
3. **Non-Custodial Escrow**: NFTs sent to `AuctionHouse` are held strictly for the duration of the auction lot and returned to seller if reserve is unmet or settled to winner.

---

## Audit & Verification Strategy

- All custom logic adheres to OpenZeppelin v5 contract interfaces (`AccessControl`, `ReentrancyGuard`, `Pausable`, `ERC721`, `ERC1155`, `ERC2981`).
- Custom tests evaluate edge cases: contract bidders, zero royalty receivers, zero reserve auctions, anti-snipe extensions, and fee underflow boundaries.
