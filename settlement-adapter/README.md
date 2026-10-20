# AjoCircle settlement adapter (prototype)

This crate is an isolated, testable validation core. It is not yet connected to NEAR Intents, a 1Click API, a chain RPC, a database, or the AjoCircle contract.

## Current behavior

- Queries settlement evidence through a `SettlementSource` interface; callers must not provide a self-asserted `settled=true` flag.
- Fails closed on source errors, non-settled statuses, insufficient confirmations, and mismatches in chain, transaction, reference, destination, asset, or amount.
- Binds the payment reference to circle ID, member ID, round, exact amount, and a unique nonce.
- Rejects a reused intent ID or source-chain transaction within the running adapter process.
- Returns a `VerifiedSettlement` record only after all checks pass.

## Critical limits

- The included source is only a test mock. There is no production source implementation or real NEAR Intents integration.
- The replay sets are in memory. They do not survive a restart and are not safe for multiple adapter instances. Production must persist and atomically consume intent IDs and transaction IDs in a database with unique constraints.
- The request must come from a trusted server-side pending-intent record created before the user initiates settlement. Never accept arbitrary circle/member/round fields as trusted input from a browser.
- The production source must independently query the relevant chain/official settlement status, enforce chain-specific finality, and extract the reference from actual transaction evidence. An unavailable source is an error, not proof of failure or success.
- A verified swap is not an AjoCircle contribution. The member must still call `contribute()` with the exact NEAR deposit required by the contract. This adapter does not credit the contract or authorize a payout.
- The current contract accepts native NEAR contributions only. Supporting a different asset requires an explicit contract design and audited asset custody/accounting; this prototype does not do that.

## Run tests

```powershell
cargo test --manifest-path settlement-adapter\Cargo.toml
```

## Before production

Implement and review a real settlement-source adapter; persist pending intents and replay protection transactionally; define supported chains/assets and finality policies; authenticate the server API; add end-to-end tests against a test environment; and obtain an independent security review. Do not use for real funds.
