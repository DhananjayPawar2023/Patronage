# Patronage Engineering Roadmap

---

## Milestone 1: Local Development & Audit Remediation (Partially Complete)
- [x] Implement local EVM chain runner & solc contract compilation pipeline.
- [x] Implement SQLite Prisma schema and Viem event indexer.
- [x] Address the initial contract and upload findings.
- [x] Write automated integration test suite (`scripts/test-final-suite.mjs`).

## Milestone 2: Smart Contract Fuzzing & Invariant Verification (In Progress - Highest Priority)
- [x] Add initial Foundry property-based fuzzing coverage.
- [ ] Implement Escrow Conservation Invariant Tests (`invariant_EthBalanceMatchesEscrow`).
- [ ] Generate gas benchmarks & coverage reports.

## Milestone 3: Production Security & Wallet Authentication
- [ ] Complete EIP-4361 Sign-In With Ethereum (SIWE) session middleware in API.
- [ ] Integrate Wagmi / RainbowKit browser wallet connectors in React UI.
- [x] Add a Pinata adapter boundary; production provider failure policy still needs hardening.

## Milestone 4: Testnet & Mainnet Release Engineering
- [ ] Deploy smart contracts to Base Sepolia testnet.
- [ ] Run Slither static analysis and Solhint linter in CI/CD pipeline.
- [ ] Professional third-party contract audit.
