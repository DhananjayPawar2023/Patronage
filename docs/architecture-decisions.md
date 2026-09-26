# Patronage production architecture decisions

Status: accepted for implementation

## Decision 1: Base Sepolia first

The first deployable environment is Base Sepolia. It keeps Ethereum tooling compatible with the guide while making test transactions inexpensive. The chain ID, RPC URL, explorer URL, deployment block, and contract addresses are configuration, never constants inside marketplace UI components.

## Decision 2: Blockchain is authoritative

Ownership, auction state, bids, reserves, fees, royalties, timestamps, and settlement are read from deployed contracts or an indexer rebuilt from contract events. PostgreSQL stores indexed read models and off-chain product data; it never overwrites chain truth.

## Decision 3: No renderable demo state in production code

The web app renders an empty state until an API or indexer returns data. There are no hardcoded artworks, bids, countdowns, wallet addresses, transaction hashes, balances, or collector counts in the production surface.

## Decision 4: Transaction lifecycle is explicit

Every write action exposes preparing, wallet prompt, signature, broadcasting, pending, confirming, confirmed, failed, rejected, replaced, dropped, or timed-out state. Success UI appears only after a receipt and, where appropriate, indexer confirmation.

## Decision 5: Testnet vertical slice before breadth

The first acceptance slice is: upload an asset, pin metadata to IPFS, mint one artwork, create one lot, bid from two wallets, withdraw the outbid refund, mint one patron edition, settle the lot, index the events, and display the resulting state from the API.

## Current external blockers

- Foundry (`forge`, `anvil`, `cast`) is not installed locally.
- Docker is not installed locally.
- No RPC endpoint, deployer wallet, Pinata credentials, Supabase database, or SIWE session secret is configured.
- No deployed contract addresses exist yet.

These are environment requirements, not reasons to fabricate values in the application.
