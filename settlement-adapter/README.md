# AjoCircle settlement adapter (prototype)

This folder contains an isolated Rust validation core plus a Node.js 1Click status client. The Node.js client calls the documented `GET /v0/status` endpoint using a server-side credential and validates the response against a trusted pending-quote record. It is not connected to a production AjoCircle server, database, wallet, or contract.

## Current behavior

- The Rust core validates settlement records through a `SettlementSource` interface and rejects replay within one process.
- `oneclick.mjs` calls the documented `GET https://1click.chaindefuser.com/v0/status` endpoint, with a server-side bearer credential, a 10-second timeout, and optional `depositMemo` support.
- It accepts only `SUCCESS`, requires the original quote deposit address, destination asset, recipient, actual output amount, and at least one destination transaction hash.
- It compares those fields against a trusted server-side pending-quote record and enforces the configured minimum output amount using integer base units (`BigInt`).
- Unit tests mock the HTTP response; they do not make live API requests or prove live credentials work.

## Critical limits

- The API client is implemented but has not yet been exercised against the live 1Click service; there is no production service integration or end-to-end payment flow.
- The replay sets are in memory. They do not survive a restart and are not safe for multiple adapter instances. Production must persist and atomically consume intent IDs and transaction IDs in a database with unique constraints.
- The request must come from a trusted server-side pending-intent record created before the user initiates settlement. Never accept arbitrary circle/member/round fields as trusted input from a browser.
- The production source must independently query the relevant chain/official settlement status, enforce chain-specific finality, and extract the reference from actual transaction evidence. An unavailable source is an error, not proof of failure or success.
- A verified swap is not an AjoCircle contribution. The member must still call `contribute()` with the exact NEAR deposit required by the contract. This adapter does not credit the contract or authorize a payout.
- The current contract accepts native NEAR contributions only. Supporting a different asset requires an explicit contract design and audited asset custody/accounting; this prototype does not do that.

## Run tests

```powershell
node --test settlement-adapter\oneclick.test.mjs
cargo test --manifest-path settlement-adapter\Cargo.toml --offline
```

## Before production

Implement and review a real settlement-source adapter; persist pending intents and replay protection transactionally; define supported chains/assets and finality policies; authenticate the server API; add end-to-end tests against a test environment; and obtain an independent security review. Do not use for real funds.
