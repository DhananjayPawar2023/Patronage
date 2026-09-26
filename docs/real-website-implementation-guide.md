# Patronage: real website implementation guide

## Purpose

This document explains what is currently fake in the prototype, what must be added, and how to turn it into a functioning 1/1 digital art auction website with real wallet, storage, blockchain, indexing, and operational behavior.

## Executive decision

Do not connect the current buttons to real money yet. The prototype is a visual product shell. Before launch, every visible market value must come from a trusted source: the blockchain, an indexer rebuilt from blockchain events, or an authenticated database record for off-chain product data.

## 1. What is fake today

| Area | Current prototype | Required real behavior |
|---|---|---|
| Artwork | CSS gradients stand in for artwork. | Upload files to IPFS, generate metadata JSON, store the CID, and display the token URI. |
| Auctions | Titles, bids, countdowns, and bidder counts are hardcoded. | Read live lots from an indexer/database and calculate countdowns from an authoritative chain timestamp. |
| Wallet | Connect button changes text locally. | Use wagmi/RainbowKit, enforce the correct network, request signatures/transactions, and display receipt states. |
| Bidding | Bid button only shows a toast. | Call the auction contract, validate the minimum bid, track pending/confirmed/reverted states, and refresh from indexed events. |
| Patron edition | Explanation only; mint button shows a toast. | Use a soulbound token contract, enforce the auction window, and show the mint transaction and resulting token. |
| Artists | Static names and collector counts. | Store profiles off-chain and derive ownership, works, royalties, and activity from wallets and indexed events. |
| Authentication | No account/session. | Add SIWE nonce generation, signed-message verification, secure sessions, logout, and wallet-change invalidation. |
| Fees and royalties | Display-only concept. | Encode fee/royalty rules in tested contracts and show the exact terms before signing. |
| Operations | No moderation, admin, alerts, or recovery. | Add artist approval, content moderation, monitoring, backups, support, and emergency procedures. |

## 2. Target architecture

1. **Frontend:** Next.js or the current Vite app temporarily; React Query for server state and wagmi/viem for chain state.
2. **Wallet and identity:** RainbowKit + wagmi for wallet connection and SIWE for passwordless sign-in.
3. **Smart contracts:** Solidity with OpenZeppelin, deployed to Base Sepolia first.
4. **Storage:** Pinata or another IPFS pinning provider for artwork and metadata. Store CIDs, not mutable local URLs.
5. **Indexer/API:** Node.js service using viem or a subgraph to listen for `LotCreated`, `BidPlaced`, `LotSettled`, `PatronMinted`, and withdrawal events.
6. **Database:** Supabase Postgres for indexed market data, profiles, follows, notifications, moderation, and transaction status.
7. **Hosting/operations:** Vercel, Supabase, managed RPC, error monitoring, transaction monitoring, and alerting.

## 3. Smart contracts to add

### ArtistFactory

Deploy inexpensive EIP-1167 clones for artist-specific NFT contracts and emit the artist/collection address.

### ArtworkNFT

Implement one-of-one ERC-721 minting, metadata URIs, creator ownership, and EIP-2981 royalties. Prevent unauthorized minting and enforce the one-of-one invariant.

### PatronEdition

Mint only during the linked lot's live window. Transfers and approvals must revert so the edition remains soulbound. Define the exact price, payment recipient, and supply rule.

### AuctionHouse

Implement:

- `createLot()` with NFT address, token ID, reserve, increment, start, and end time.
- `placeBid()` with minimum increment validation and anti-snipe extension.
- Pull-payment refunds for outbid bidders.
- `settle()` that transfers the NFT and splits creator/protocol funds.
- Reentrancy protection, access control, pause behavior, and event emission.

### Required contract tests

- No-bid settlement.
- Reserve not met.
- Valid first bid and minimum-increment rejection.
- Outbid refund withdrawal.
- Last-second bid and anti-snipe extension.
- Settlement and fee split.
- Malicious receiver/reentrancy attempt.
- Wrong caller, invalid lot, zero address, and invalid time parameters.
- Patron mint outside the auction window.
- Soulbound transfer and approval reverts.
- Royalty calculation and rounding.

Use OpenZeppelin `Ownable` or `AccessControl`, `ReentrancyGuard`, `Clones`, ERC-721/ERC-1155, and `IERC2981`. Never hand-roll access control or reentrancy guards.

## 4. Frontend changes

### Home feed

Fetch paginated lots from an API or indexed query. Add loading, empty, stale, and error states. Display the chain, contract, token ID, last indexed block, and a clear testnet label.

### Lot detail

Load a lot by chain ID, auction address, and lot ID. Show creator, artwork CID, reserve state, current bid, bid history, patron availability, fee/royalty terms, transaction links, and settlement state.

### Bid flow

Require a connected wallet and the correct network. Validate the bid against the current bid plus increment. Call the contract and handle wallet rejection, RPC failure, pending, confirmed, replaced, and reverted transactions.

### Create flow

Require artist profile, file upload, metadata preview, IPFS pin confirmation, wallet signature, NFT mint receipt, and lot creation receipt. Only show a live auction after the receipts are confirmed and indexed.

### Countdown and status

Use an authoritative `endTime`. Do not imply a bid was accepted until the transaction is confirmed. Show indexer lag instead of silently showing stale numbers.

### Trust UI

Show contract addresses, chain, token ID, transaction hashes, IPFS CID, fee/royalty terms, and whether the current environment is testnet or mainnet.

## 5. Backend, indexer, and database

Minimum tables:

- `artists`: wallet address, handle, bio, avatar CID, approval status, timestamps.
- `lots`: chain ID, auction address, lot ID, NFT address, token ID, creator, reserve, highest bid, end time, status, transaction hash.
- `bids`: lot ID, bidder, amount, transaction hash, block, timestamp, status.
- `patron_mints`: lot ID, patron, token ID, amount, transaction hash, timestamp.
- `follows`: follower wallet, artist ID, timestamp.
- `transactions`: hash, wallet, type, state, error code, created/confirmed timestamps.
- `moderation`: asset CID, artist, status, reviewer, reason, reviewed timestamp.

Indexer acceptance criteria:

- Replays from a deployment block and rebuilds the database from events.
- Handles reorgs and confirmation depth.
- Is idempotent when the same event is delivered twice.
- Stores raw event identifiers and the last processed block.
- Exposes indexer health and lag to operators and the frontend.
- Never treats a form submission as proof of ownership or settlement.

## 6. Environment and secrets

Create separate development, testnet, and production configuration.

| Variable | Rule |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | Public; must match the selected network. |
| `NEXT_PUBLIC_RPC_URL` | Client-safe RPC or server proxy with rate limits. |
| `DEPLOYER_PRIVATE_KEY` | Deployment-only secret; use a dedicated test wallet. |
| `PINATA_JWT` | Server-only secret for controlled IPFS uploads. |
| `DATABASE_URL` | Server/indexer secret with least privilege. |
| `SIWE_SESSION_SECRET` | Server-only secret; rotate and use short-lived sessions. |
| `PROTOCOL_FEE_BPS` / `CREATOR_ROYALTY_BPS` | Must match contract rules and be shown before signing. |

Never expose private keys, seed phrases, Pinata credentials, database credentials, or session secrets in the frontend.

## 7. Phased build plan

### Phase 0 - lock product decisions

Choose Base Sepolia or Ethereum Sepolia. Define fees, royalties, reserve policy, patron price, auction duration, anti-snipe extension, artist approval policy, and platform owner/operator.

### Phase 1 - contract layer

Implement OpenZeppelin contracts, Foundry tests, fuzz/invariant tests, deployment scripts, verified testnet deployments, and a contract address registry.

### Phase 2 - storage and creation

Add IPFS upload and metadata generation. The create flow must wait for pinning, mint, and lot receipts.

### Phase 3 - indexer and API

Index events into Postgres, add idempotency and reorg handling, expose read APIs, and add transaction-status polling.

### Phase 4 - wallet and auth frontend

Add wallet connection, network switching, SIWE sessions, real bid/mint/create flows, and complete receipt UX.

### Phase 5 - moderation and operations

Add artist applications, content review, takedown process, admin roles, RPC failover, monitoring, email notifications, backups, and support workflows.

### Phase 6 - testnet pilot

Use multiple wallets and browsers to test outbid refunds, late bids, no bids, reserve failure, failed transactions, reorgs, and indexer delay.

### Phase 7 - launch readiness

Complete an independent contract review, legal review, privacy/security review, incident-response plan, terms, disclosures, low limits, and a staged L2 launch.

## 8. Definition of “real”

- Every artwork has a verifiable IPFS CID and token metadata URI.
- Every live lot maps to a deployed contract, chain ID, token ID, and indexed lot ID.
- Every bid, patron mint, settlement, refund, and payout has a transaction hash and receipt state.
- Refreshing or opening another device shows the same state from the indexer.
- Wrong-network and disconnected-wallet actions are blocked clearly.
- Failed or replaced transactions never produce false success UI.
- The app clearly distinguishes testnet from mainnet and does not imply USD settlement when settlement is ETH.
- Admin and moderation actions are authenticated, logged, least-privilege, and reversible where possible.
- No unresolved critical or high-severity contract issue remains after security review.
- Legal counsel approves the operating model, terms, privacy policy, disclosures, and jurisdiction approach.

## 9. Immediate next actions

1. Keep the current UI as the product shell, but render only indexed data and honest empty states.
2. Create separate `contracts/`, `indexer/`, and `frontend/` packages.
3. Implement and test `AuctionHouse` first because it controls the highest-risk money movement.
4. Choose Base Sepolia and create a dedicated deployer test wallet funded only with faucet ETH.
5. Complete one vertical slice: upload one artwork, mint one NFT, create one auction, place two bids from separate wallets, withdraw the outbid refund, mint one patron edition, and settle the auction.
6. Expand feed sorting, social features, notifications, and mainnet preparation only after that vertical slice is repeatable.

## Important boundary

This is an engineering implementation guide, not legal or financial advice. A platform handling real value needs a qualified smart-contract auditor and a lawyer familiar with digital assets, consumer protection, payments, sanctions/AML, privacy, and the jurisdictions where the platform operates.
