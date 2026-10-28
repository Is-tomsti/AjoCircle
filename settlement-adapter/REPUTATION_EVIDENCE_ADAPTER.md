# Reputation Evidence Adapter — Integration Gate

## Status

The SQLite `MemberReputationStore` is implemented and tested, including restart persistence, canonical payload validation, unique evidence references, and reviewer-authorized dispute resolution. It is not yet connected to the HTTP API or frontend. The store intentionally requires an injected `verifyEvidence` callback; the tests use a fixture verifier and are not production evidence verification.

## Why a generic `verified: true` flag is insufficient

The scoring function is a deterministic calculator, not a chain indexer. A server-side ingestion path must prove the event from an authoritative source before calling `appendVerifiedEvent()`. Browser-supplied payload fields, a user-entered transaction hash, a mock provider response, or a local SQLite row must never establish the `verified` property by themselves.

## Required evidence checks

For a NEAR contribution outcome, the verifier must establish all of the following from finalized testnet evidence:

1. Network is NEAR testnet and the contract account is the expected registered contract for the circle.
2. The contract account's deployed code hash is in the approved allowlist and the observed circle/member/schedule state matches the trusted local circle configuration.
3. The transaction hash resolves to a finalized successful transaction; its signer, receiver, function-call method, attached native NEAR deposit, and execution outcome match the expected contribution operation.
4. The relevant block timestamp is obtained from trusted RPC data, not from the client, and compared against the exact configured round deadline and grace-period rule.
5. The transaction/member/circle/round/amount tuple is canonical and unique. A repeated transaction or evidence reference cannot create another outcome.
6. If the contract does not expose enough historical state to establish the outcome (for example, a missed contribution after a deadline), the verifier must refuse to infer it. A finalized event indexer or trusted archived state at the relevant block is required.

For settlement evidence, additionally validate the stored trusted quote intent, exact recipient, destination asset, amount, and successful delivery evidence. Swap delivery is not proof that native NEAR `contribute()` succeeded; the current product flow requires that separate contract call.

## Scoring and dispute invariants

- Only canonical outcome fields enter the scoring function. Caller flags such as `verified`, `disputed`, or `disputeStatus` are stripped from event payloads.
- An open dispute is visible and excluded from scoring. An authorized reviewer may resolve it as upheld or reversed. Resolved dispute records cannot be overwritten or casually reopened.
- Reviewer authorization must derive from a verified server-side principal and explicit role/policy; it must not be inferred from a request body or member ID supplied by the browser.
- Event evidence is append-only. Corrections must preserve the original evidence and be represented by an auditable dispute/correction process.
- A trust score is not a guarantee of future payment or circle completion.

## Integration sequence

1. Implement a read-only NEAR transaction/evidence verifier that uses finalized RPC data and the approved contract verification policy.
2. Add fixtures for successful, failed, wrong-signer, wrong-contract, wrong-method, wrong-deposit, unfinalized, replayed, wrong-deadline, and malformed RPC responses.
3. Add a separate verified settlement-evidence verifier for 1Click delivery, keeping delivery separate from contract contribution.
4. Build a server-only ingestion service that derives member/circle identity from trusted records and calls `MemberReputationStore` only after verification.
5. Expose profile reads through authenticated membership-gated routes. Keep ingestion and dispute review server-side and role-authorized; never expose the store itself to clients.
6. Connect the UI only after the verifier, authorization, and restart-persistence integration tests pass.

## Explicit non-goals

- Do not treat the completed Cycle 4 as an active cycle or create quotes for it.
- Do not extend deadlines, reopen the cycle, repeat payouts, or submit any transaction to make test evidence.
- Do not add reputation fields to the deployed contract state without a separate storage migration design.
- Do not synthesize missed/default events from absence of a current contribution view alone.


## Read-only finalized contribution verifier checkpoint

`near-contribution-evidence.mjs` now provides a read-only verifier for an individual native-NEAR `contribute()` transaction. It checks the testnet RPC endpoint, the currently deployed contract WASM SHA-256 against an explicit allowlist, finalized transaction status, transaction hash, trusted member signer, registered contract receiver, exactly one `contribute` action, exact attached yoctoNEAR amount, successful execution, and finalized block timestamp against the trusted configured deadline. Large nanosecond timestamps are preserved as decimal strings when parsing raw RPC JSON. The returned digest is derived from the verified transaction tuple and block evidence.

`near-contribution-evidence.test.mjs` exercises success plus wrong signer/receiver/method/deposit, failed and unfinalized execution, unapproved code, late timestamp, and non-testnet RPC refusal. These are mocked RPC fixtures; they are not live-chain validation. The verifier is **not wired into the store or any API**, and its expected signer/contract/amount/deadline must be resolved from trusted server-side records. Do not accept those expected values from the browser.

**Important limitation:** the allowlist check observes the contract code deployed at the time of verification; it does not prove historical code identity at the transaction's block. Before production, add historical code/state proof or a trusted finalized indexer, validate that the transaction belongs to the intended circle and round, and define the grace-period policy. The verifier currently rejects transactions after the configured deadline rather than classifying them as late. It cannot prove a missed/default obligation from absence of a transaction. No API or frontend integration is enabled by this checkpoint.


## Server-only contribution reputation ingestion boundary

`contribution-reputation-ingestion.mjs` adds a server-only orchestration module. It accepts an authenticated principal, circle ID, round, and transaction hash; resolves the member through a trusted identity callback; loads the trusted circle/member/round snapshot; checks active statuses; and supplies the expected contract, signer, exact amount, and nanosecond deadline to the evidence verifier. It rejects mismatched verifier output and writes only a canonical `ON_TIME` obligation to `MemberReputationStore`. Stable circle/round/member obligation IDs prevent multiple successful evidence submissions from creating multiple scoreable records for the same obligation.

The module is deliberately not an HTTP route and is not wired into `ajo-testnet-app-server.mjs`. It requires an injected `verifyRoundBinding` callback to prove that the finalized transaction belongs to the intended contract round. The native `contribute()` action does not encode a round, so current contract state is insufficient after a cycle advances. Tests use a mock callback; no production historical indexer is implemented or configured. Keep real ingestion unavailable until that verifier exists and is independently tested. Production construction must use the verified session principal and authoritative `ApplicationStore`-backed resolvers, not request-body member IDs or schedule values. Keep write access server-only; the existing generic API does not expose reputation ingestion or dispute review.

`contribution-reputation-ingestion.test.mjs` tests the trust boundary and replay behavior. Tests use controlled fixture resolvers/verifier and do not prove the production RPC provider or application deployment. The full adapter suite should be rerun after each integration change. The service also exports `createApplicationBackedContributionReputationIngestion()`, which resolves identity and trusted contribution context from `ApplicationStore` using an authenticated principal. It is covered by SQLite integration tests but is still not connected to an HTTP route or frontend. Its test verifier is mocked, so these tests do not establish live-chain evidence.


## Indexed historical round-binding adapter checkpoint

near-indexed-round-binding.mjs adds a strict, server-side adapter for the FastNear testnet Transactions API (https://tx.test.fastnear.com/v0/transactions). It checks the indexed transaction hash, signer, receiver, exact single contribute() action and amount, and requires the indexed execution block hash to match the block hash already verified by the NEAR RPC evidence verifier. It then requires exactly one matching EVENT_JSON record emitted by the contract receipt with standard ajocircle, version 1.0.0, event contribution_recorded, and exact member, round, and amount fields. A proof reference and SHA-256 digest are returned only when all checks pass. An optional FASTNEAR_API_KEY environment variable is sent as a bearer token.

**This is not enabled in production and does not make existing transactions verifiable.** The currently deployed AjoCircle contract's approved code hash is still the legacy version and does not emit the required round event. Legacy transactions therefore fail closed. The local contract source now emits `contribution_recorded` after a contribution passes every existing check and is recorded, including the contract's zero-based `current_round`, predecessor member, and exact attached amount. This source change has passed the Rust unit suite, but it has not been built for WASM or deployed; the deployed code hash and all existing circles remain untouched.

The indexer response is provider-attested data, not a cryptographic state proof. Before production use, validate the real testnet response schema, availability/authentication requirements, and reconcile the transaction and receipt against canonical NEAR RPC. The source change still requires an explicit review, WASM build and compatibility checks, deliberate deployment approval, and new testnet validation on a separate disposable test circle. Do not upgrade or redeploy any existing or completed circle to enable this work. The adapter and tests remain standalone; no API/frontend route uses them. Tests use synthetic indexed responses and prove parsing/fail-closed behavior only, not live FastNear integration or deployed contract event behavior.


### Follow-up correction — WASM build status (2026-10-24)

The statement above that the event-emitting contract source had not been built for WASM is superseded by this checkpoint: the release WASM build subsequently completed successfully using the offline Rust build. Reported artifact SHA-256: `39E25E33B245CF6B1DB3F4F3FBCEC074796308D5741E4C058017123BBBC19674`. This artifact has **not** been deployed, and its hash has **not** been added to the contract verification allowlist. No testnet deployment or contribution transaction was submitted. The existing deployment script remains unsuitable because it targets `ajocircle.testnet`, expects a stale artifact hash, and requires a clean tree matching `origin/main`; do not use it for this checkpoint.


### Follow-up correction — isolated live event verification completed (2026-10-24)

The prior note saying the event-emitting build had not been deployed is superseded by the isolated testnet validation recorded in `TESTNET_EVENT_VERIFICATION_PREFLIGHT.md`.

- Disposable contract: `event-proof-20261024.ajocircle.testnet`.
- Deployed WASM SHA-256: `39e25e33b245cf6b1db3f4f3fbcec074796308d5741e4c058017123bbbc19674`; this exact hash is now in `APPROVED_AJOCIRCLE_TESTNET_SHA256S` after source/artifact review and successful live validation.
- Single authorized test contribution: transaction `4WDSWBFwoukZrRBDfuZffBfZrgrajGoBrfBwuMHHsMBE`, signer `ajotest1.testnet`, 1 NEAR, round `0`.
- Canonical NEAR RPC verifier and FastNear indexed round-binding verifier both passed using the production allowlist, finalized block `2atms6gpLFZPn4ojnQ1NXxfAj6sAWh4uQ6ky8x6rjjTe`, and unique matching receipt `3X8oZsfbZ2RsMXN4GCTsPmgfnVnC7PEiTV1WZwSBCTXb`.
- The indexer proof digest is `sha256:33aa6acef60f7366143a57e94584cc191e39051c353ac2eed9d47914a6992f5f`.

This verifies the isolated event-evidence path against one real testnet transaction. It does **not** enable reputation ingestion or quote creation, and it does not prove a cryptographic state proof or historical code identity at arbitrary transaction blocks. The test circle ID used for the one-off proof is a diagnostic label, not a persisted application circle; do not score or ingest this contribution as a real application obligation. Do not touch Cycle 4 or reuse the legacy deployment script.


### Follow-up implementation — default live round binding in application-backed ingestion (2026-10-24)

`createApplicationBackedContributionReputationIngestion()` now defaults to the real `verifyIndexedContributionRoundBinding()` adapter when no test override is supplied. The default passes the transaction hash, trusted contract/signer/round context, the base verifier's exact amount and finalized block hash, and the configured fetch implementation to the fixed FastNear testnet endpoint. The existing trusted `ApplicationStore` identity/context resolution and stable obligation key remain in force.

A new application-backed integration test exercises this default with a controlled indexer response matching the real event schema and verifies that a scoreable record is written only after the unique round-binding check passes. This is a deterministic fixture test, not another live transaction. Focused ingestion tests: 8 passed.

**Still intentionally not exposed through HTTP or the frontend.** The production server must not instantiate a reputation store with a weak evidence callback, accept browser-provided member/round context, or turn the isolated diagnostic test into a real score. Before route wiring, provide a durable verifier-evidence handoff/store so the store's own `verifyEvidence` callback independently validates the canonical evidence reference and digest, and define an authenticated member-facing submission contract with size limits and replay/error handling.
