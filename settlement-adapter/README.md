# AjoCircle settlement adapter (prototype)

This folder contains an isolated Rust validation core, a Node.js 1Click status client, and a SQLite-backed settlement-record prototype. The Node.js pieces are not connected to a production AjoCircle server, wallet, or contract.

## Current behavior

- The Rust core validates settlement records through a `SettlementSource` interface and rejects replay within one process.
- `oneclick.mjs` calls the documented `GET https://1click.chaindefuser.com/v0/status` endpoint, with a server-side bearer credential, a 10-second timeout, and optional `depositMemo` support.
- It accepts only `SUCCESS`, requires the original quote deposit address, destination asset, recipient, actual output amount, and at least one destination transaction hash.
- It compares those fields against a trusted server-side pending-quote record and enforces the configured minimum output amount using integer base units (`BigInt`).
- Unit tests mock the HTTP response; they do not make live API requests or prove live credentials work.

## Server-side verification workflow

settlement-service.mjs exports verifyPendingIntentDelivery({ store, statusClient, intentId }). The caller supplies only the intent ID; the service loads the deposit address and expected delivery fields from the trusted database record, asks the configured status client for the 1Click status, and atomically records verified delivery. It refuses missing or already-consumed intents. Do not expose the raw store or allow a browser to choose circle/member/round/recipient/amount fields.

Example (server-side only):

```js
import { SettlementStore } from './settlement-store.mjs';
import { OneClickStatusClient } from './oneclick.mjs';
import { verifyPendingIntentDelivery } from './settlement-service.mjs';

const store = new SettlementStore({ path: 'data/settlement.sqlite' });
const statusClient = new OneClickStatusClient({ bearerToken: process.env.ONECLICK_API_KEY });
const result = await verifyPendingIntentDelivery({ store, statusClient, intentId });
```

This example assumes intentId was created earlier from a trusted quote flow. Keep the credential in server environment configuration; never ship it to a browser. The service is a callable module, not an HTTP server or production API endpoint.

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
node --test settlement-adapter/oneclick.test.mjs settlement-adapter/settlement-store.test.mjs settlement-adapter/settlement-service.test.mjs
cargo test --manifest-path settlement-adapter\Cargo.toml --offline
```

## Before production

Implement and review a real settlement-source adapter; persist pending intents and replay protection transactionally; define supported chains/assets and finality policies; authenticate the server API; add end-to-end tests against a test environment; and obtain an independent security review. Do not use for real funds.

## Member-mediated quote request builder

`quote-request.mjs` constructs a validated 1Click exact-input request that targets the member's NEAR account and requests `nep141:wrap.near`. It validates base-unit amounts, recipient/refund fields, slippage bounds, and deposit mode. Its tests are local unit tests only; it does not call the 1Click API, store a quote, or mark a circle contribution complete.

This is the first integration step for the member-mediated MVP. A quote must be generated from trusted server-side circle/member state, and a delivered wrapped-NEAR swap must still be followed by the member's native-NEAR `contribute()` call under the current contract.


## Trusted quote creation workflow (local prototype)

`oneclick-quote.mjs` adds a server-side `POST /v0/quote` client. It requires a server-held 1Click credential, validates the echoed quote request, checks integer base-unit output values, and retains the deposit address, optional memo, deadline, signature, and correlation ID. Tests mock the HTTP response; no live quote request was sent.

`quote-service.mjs` exports `createTrustedMemberQuote(...)`. The caller must provide a trusted `resolveTrustedContext` implementation backed by the application's authoritative circle/member/round records. The resolver must return matching IDs and statuses (`ACTIVE`, `ACTIVE`, `OPEN`), the member's NEAR account, required contribution amount in base units, allowed origin assets, the registered refund address for each asset, and a per-asset maximum input amount. The service rejects unknown assets, unregistered refund addresses, inactive/closed rounds, oversized input, mismatched quote data, and a quoted minimum output below the required contribution amount. It then creates a durable pending intent.

The SQLite store adds quote metadata columns using additive schema migration, so existing databases are retained. Deposit memos are stored and passed back to the status endpoint when verifying settlement. Quote signatures and correlation IDs are stored for traceability. Do not expose the store or trusted-context resolver to browser code; this is a module boundary, not an authenticated HTTP server.

**Important product boundary:** a successful quote or verified wrapped-NEAR delivery is not a contribution. The member still needs to unwrap and call the current contract's native-NEAR `contribute()` method with the exact amount. The quote service is not connected to a live application database or frontend, and it has not been tested with real 1Click credentials or funds.

Tests: `node --test settlement-adapter\oneclick-quote.test.mjs settlement-adapter\quote-service.test.mjs settlement-adapter\oneclick.test.mjs settlement-adapter\settlement-store.test.mjs settlement-adapter\settlement-service.test.mjs`.


## Member contribution status projection

`contribution-status.mjs` exports `getMemberContributionStatus({ store, contractClient, intentId })`. The `contractClient` must read the authoritative contract views (`getRound`, `getContribution`, `isCircleCompleted`, `isPayoutPending`, and `isPayoutComplete`). The projection reports swap settlement separately from on-chain contribution state and only reports `CONTRIBUTION_CONFIRMED` when the contract round matches the stored intent round and the member's on-chain contribution exactly matches the trusted native-NEAR amount recorded from circle state.

If the swap is verified but the contract has no contribution, the next action is `UNWRAP_AND_SUBMIT_NATIVE_NEAR_CONTRIBUTION`. This module is a read-only status projection: it does not unwrap assets, submit transactions, or claim that the swap itself satisfies the contribution requirement. A live contract RPC client and authenticated application endpoint remain to be integrated.
