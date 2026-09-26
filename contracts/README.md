# Patronage contracts

These contracts are designed for Base Sepolia first and use OpenZeppelin primitives. They are not mainnet-ready until compiled, unit-tested, fuzz-tested, statically analyzed, and independently reviewed.

## Local setup

Install Foundry, then from this directory:

```bash
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install foundry-rs/forge-std --no-commit
forge build
forge test -vvv
```

The deployer must use a dedicated test wallet. Contract addresses and the deployment block belong in deployment configuration and the indexer, not in the frontend source.

## Deployment order

1. Deploy `Treasury`.
2. Deploy `AuctionHouse` with the treasury, protocol fee in basis points, and anti-snipe window.
3. Deploy `PatronEdition` and grant its auction role to the deployed auction component.
4. Deploy `ArtistFactory` with the auction address and royalty basis points.
5. Deploy `PlatformRegistry`, register component addresses, and approve artists through the operator role.
6. Verify contracts on the Base Sepolia explorer and record the deployment block for indexing.

Do not accept real funds until an independent security review has passed.
