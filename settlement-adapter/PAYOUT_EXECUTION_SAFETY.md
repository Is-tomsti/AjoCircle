# Payout execution safety ledger (prototype)

`payout-execution-store.mjs` adds a durable SQLite state ledger for payout plans. It is deliberately **not** wired to an HTTP endpoint, NEAR signer, or transaction submitter.

## State machine

- `PREPARED`: created only from a server-trusted, verified testnet readiness snapshot and unique per contract/round.
- `AUTHORIZED`: a second authenticated operator (different from the preparer) confirms the exact phrase `AUTHORIZE TESTNET PAYOUT <contractId> ROUND <round>`.
- `SUBMITTED`: records a transaction hash supplied by a separate approved submission component. This store does not submit it.
- `UNKNOWN`: the submission outcome is uncertain. This is a stop state for reconciliation; do not retry or submit again.
- `FINALIZED`: a separate trusted verifier has independently confirmed successful finality and matching transaction hash, then records an evidence reference.
- `FAILED`: a separate trusted verifier confirms a definitive failure. The round's unique key remains occupied; this store does not automatically create a replacement plan.

## Security boundaries

- Testnet only. The ledger itself never signs or submits. The separate `near-cli-payout-submitter.mjs` component invokes the existing NEAR CLI keychain only after the authenticated API has verified an `AUTHORIZED` plan, exact confirmation phrase, fresh deployed code hash, local/on-chain schedule parity, readiness, and a matching on-chain FullAccess public key. It submits only `release_payout()` with `{}` arguments and zero deposit.
- The store's methods are persistence primitives, not proof that a caller is authenticated or that evidence is truthful. The API authenticates an active member for the selected circle, requires the independent second-operator authorization already stored in the plan, repeats the code-hash/parity/readiness checks server-side, and independently verifies transaction evidence before recording submission or finality.
- A timeout is not proof of failure. Reconcile contract state and transaction status before any manual recovery.
- The CLI submission endpoint is reachable only through the local app server bound to `127.0.0.1` and the configured app origin. The app requires a final confirmation dialog that names the contract, round, recipient, amount, code hash, testnet, and local CLI signer. A timeout or missing transaction hash is recorded as `UNKNOWN`; never retry until reconciled.

Run tests:

```powershell
node --test settlement-adapter/payout-execution-handler.test.mjs settlement-adapter/payout-execution-store.test.mjs settlement-adapter/near-cli-payout-submitter.test.mjs
```
