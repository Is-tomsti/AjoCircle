# AjoCircle settlement adapter (prototype)

This folder contains an isolated Rust validation core, a Node.js 1Click status client, and a SQLite-backed settlement-record prototype. The Node.js pieces are not connected to a production AjoCircle server, wallet, or contract.

## Current behavior

- The Rust core validates settlement records through a `SettlementSource` interface and rejects replay within one process.
- `oneclick.mjs` calls the documented `GET https://1click.chaindefuser.com/v0/status` endpoint, with a server-side bearer credential, a 10-second timeout, and optional `depositMemo` support.
- It accepts only `SUCCESS`, requires the original quote deposit address, destination asset, recipient, actual output amount, and at least one destination transaction hash.
- It compares those fields against a trusted server-side pending-quote record and enforces the configured minimum output amount using integer base units (`BigInt`).
- Unit tests mock the HTTP response; they do not make live API requests or prove live credentials work.

## Critical limits

- The API client is implemented but has not yet been exercised against the live 1Click service; there is no production service integration or end-to-end payment flow.
- The Rust core's replay sets remain in memory. The new Node.js SQLite store persists pending intents and verified-delivery records across restarts and uses a write transaction plus unique constraints to block duplicate intent IDs, deposit addresses, and destination transaction hashes. It is still a prototype and is not integrated into a production server.
- The request must come from a trusted server-side pending-intent record created before the user initiates settlement. Never accept arbitrary circle/member/round fields as trusted input from a browser.
- The production source must independently query the relevant chain/official settlement status, enforce chain-specific finality, and extract the reference from actual transaction evidence. An unavailable source is an error, not proof of failure or success.
- A verified swap is not an AjoCircle contribution. The member must still call `contribute()` with the exact NEAR deposit required by the contract. This adapter does not credit the contract or authorize a payout.
- The current contract accepts native NEAR contributions only. Supporting a different asset requires an explicit contract design and audited asset custody/accounting; this prototype does not do that.

## Durable settlement-record prototype

settlement-store.mjs uses Node.js node:sqlite (Node 22.5+; tested here with Node 24.19.0). Create a store with new SettlementStore({ path: 'data/settlement.sqlite' }); the default :memory: path is for tests only. Create each pending intent from trusted server-side quote data with createPendingIntent(...). Then load the stored intent and pass the observed parsed 1Click status to claimVerifiedDelivery(intentId, observed).

The store atomically checks that the intent is still pending, verifies delivery against the stored deposit address/asset/recipient/minimum, inserts globally unique destination transaction hashes, and changes the state to VERIFIED_DELIVERY. Any failure rolls back the transaction. This state means only that the destination delivery was verified; it does not mean AjoCircle received a contribution, and it does not trigger contract credit or payout.

The test suite uses temporary SQLite files and mocked status payloads. It does not test live 1Click credentials, multi-process production deployment, chain finality, or a live contract flow.

## Run tests

```powershell
node --test settlement-adapter\oneclick.test.mjs settlement-adapter\settlement-store.test.mjs
cargo test --manifest-path settlement-adapter\Cargo.toml --offline
```

## Before production

Implement and review a real settlement-source adapter; persist pending intents and replay protection transactionally; define supported chains/assets and finality policies; authenticate the server API; add end-to-end tests against a test environment; and obtain an independent security review. Do not use for real funds.
