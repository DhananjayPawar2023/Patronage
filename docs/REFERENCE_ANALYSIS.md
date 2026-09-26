# Patronage Reference Repository & Architectural Analysis

> **DOCUMENT PURPOSE**  
> Evaluates the Patronage codebase against industry-standard open-source reference implementations (**1001-digital**, **networked-art**, **evmnow**, **signinwithethereum**, **jwahdatehagh**, **openzeppelin-contracts**, **solmate**, **foundry**, **viem**, **wagmi**).

---

## 1. Reference Architecture Mapping

| Domain / Subsystem | Primary Reference Repositories | Core Design Pattern Adopted | Differences / Justification in Patronage |
| :--- | :--- | :--- | :--- |
| **Smart Contracts** | `openzeppelin-contracts`, `evmnow`, `solmate` | OpenZeppelin v5 AccessControl, ReentrancyGuard, ERC721, ERC1155, EIP-2981 | Lightweight custom timed English auction contract with pull refunds (`refundable` mapping) and capped protocol fees. |
| **Minimal Proxy Clones** | `1001-digital`, `networked-art` | EIP-1167 Minimal Proxy Clones (`Clones.clone`) via `ArtistFactory.sol` | Clones `ArtworkNFT` per artist; initialized with custom `name()`, `symbol()`, and artist royalty receiver. |
| **Authentication** | `signinwithethereum` (EIP-4361) | SIWE message signing & session verification | **Current Status**: Local Dev Mode uses pre-funded Anvil accounts directly via Viem. SIWE production wrapper is required before mainnet. |
| **Indexing & Persistence** | `1001-digital`, `networked-art` | Event-driven block listener + relational schema (`Prisma` / `SQLite`) | Viem log listener with atomic `prisma.$transaction([])` batching for `LotCreated`, `BidPlaced`, `LotSettled`, `LotCancelled`. |
| **Storage & Metadata** | `networked-art`, `1001-digital` | Content-addressed IPFS / local storage fallback | `LocalStorageProvider` computes SHA-256 digests, enforces 10MB limits, strict image MIME whitelists, and serves static files locally. |
| **Wallet Interaction** | `wevm/viem`, `wevm/wagmi` | Type-safe Viem clients & JSON-RPC transport | Viem client initialized with Foundry local chain transport; local dev modal switching accounts dynamically. |

---

## 2. Detailed Reference Comparisons

### A. Authentication (EIP-4361 SIWE)
* **Production Standard (`signinwithethereum`)**: Uses cryptographically generated EIP-4361 messages signed by browser wallets (e.g. MetaMask), verified on backend endpoints via `siwe` SDK to issue HTTP-only JWT/cookie sessions.
* **Patronage Local Implementation**: Uses Viem `walletClient` directly in the browser with pre-funded local EVM private keys.
* **Assessment**: Excellent for local offline development; SIWE wrapper endpoint required for production deployment.

### B. Indexer Architecture & Re-org Safety
* **Production Standard (`1001-digital` / Goldsky / Envio)**: Indexers poll RPC blocks, maintain a `block_progress` table, process log arrays in single-transaction batches, and roll back state if a chain re-org is detected (`block.parentHash` mismatch).
* **Patronage Local Implementation**: Process logs via `prisma.$transaction([])` per log entry. Maintains `IndexedEvent` idempotency table.
* **Assessment**: Highly reliable for local single-node EVM; re-org rollback handler required for multi-validator L1/L2 networks.

### C. Smart Contract Escrow & Settlement
* **Production Standard (`evmnow` / Zora / Nouns)**: Non-custodial escrow where NFTs are held by the auction contract during active bidding. Settlements distribute ETH payouts to seller/treasury and transfer NFT to winner.
* **Patronage Local Implementation**: Fully implemented in `AuctionHouse.sol`. `_safePay()` ensures that reverting payment calls to sellers or royalty receivers fall back to `refundable[recipient]` balances rather than reverting settlement.
* **Assessment**: Verified secure against DoS and fund-locking attack vectors.
