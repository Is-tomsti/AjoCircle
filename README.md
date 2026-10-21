# Ajo Circle

A rotating savings circle built on NEAR Protocol, designed for transparent contributions, controlled payouts, and cross-chain participation.

## Project status

Ajo Circle is under active development. The current contract is an initial prototype; it is not audited and should not be used to custody real funds.

### Reputation and discovery

`AJO_REPUTATION_SPEC.md` defines the public-by-default trust profile, searchable circle eligibility, circle modes, transparent fee rules, and payout-protection invariants. The contract now includes a pure Rust reputation module with a deterministic 0–1,000 score and eligibility checks. These helpers are not yet wired to persistent, verified on-chain member histories or the frontend; they are an initial tested component, not a complete reputation product.

## Current contract scope

- Create a circle with a fixed member list, contribution amount, payout order, deadline, and treasurer account.
- Accept one exact-size NEAR deposit from each member per round before the deadline.
- Support `Private` and `ProtectedPublic` circle modes.
- In `ProtectedPublic` mode, track protection funds separately from member contributions.
- Let a member request a full-pot guarantor commitment; only the nominated guarantor can accept, and activation requires the exact full-pot amount to be deposited into contract custody.
- Expose the guarantor request, acceptance, locked amount, expiry, activation status, and last claimed round.
- After the contribution deadline, allow anyone to move at most one missing contribution per member and round from that member's active, unexpired guarantee into the separate protection reserve. Claims are rejected if the member contributed, the guarantee is inactive or expired, collateral is insufficient, or that round was already claimed.
- Keep unused guarantor collateral locked until every scheduled payout succeeds. The final successful payout marks the circle complete; a completed circle cannot advance to another round, and unused collateral can then be returned asynchronously to its guarantor. Collateral is marked unavailable before the transfer and restored if the transfer callback reports failure.
- Track protection-reserve deposits by funder. Reserve shortfalls consume recorded funder shares in deterministic insertion order; if a payout transfer fails, those shares are restored. After the circle completes, each funder can refund their unused share asynchronously, with the share restored if the refund transfer fails. Funds moved into the reserve from a claimed guarantee are not credited as refundable reserve deposits.
- Guarantee expiry still needs to be planned carefully for the circle's intended duration.
- Permit a protected public payout to cover missing contributions only after the deadline and only when the reserve covers the exact shortfall; otherwise the payout pauses.
- Reserve the shortfall while a payout is pending, keep the deduction after success, and restore it if the transfer callback reports failure.
- Restrict payout initiation and round advancement to the configured treasurer account.
- Mark a payout complete only after its transfer callback reports success.
- Expose round, contribution, mode, circle-completion status, current shortfall requirement, protection balance, and pending reserve-use views.

## Testnet deployment and demo boundary

- The contract was previously deployed to NEAR **testnet** at `ajocircle.testnet` (deployment transaction: `8H7VUVR3grQshyfGK8oyrx52MCZu3yt7DtXhgwsYfdK1`). The deployed code matched the previously built WASM artifact at the time it was checked.
- The deployed artifact predates the initializer-hardening changes now being prepared in source. Do **not** initialize the currently deployed instance. The hardened WASM has not been redeployed, and no initialization or demo funds have been sent as part of this work.
- The intended safe path is to run the complete tests, build the WASM, review the artifact, and only then use NEAR CLI's `contract deploy use-file ... with-init-call new ...` flow to submit deployment plus initialization in one transaction. The transaction must be signed by `ajocircle.testnet`'s own authorized account key so `predecessor_account_id == current_account_id`; do not use an outsider signer. This is documentation of the mechanism, not authorization to execute it.
- `deploy-init-testnet.ps1` runs read-only testnet preflight and a dry run by default: it verifies the pushed source/documentation commit, expected WASM SHA-256, empty contract storage, member balances, and the `ajocircle.testnet` keychain public key against its on-chain FullAccess key. It then fetches a fresh finalized block timestamp, generates a 15-minute initialization JSON in the system temp directory, and prints the exact near-cli-rs command. The default run sends no transaction. `.\deploy-init-testnet.ps1 -Execute` repeats the checks, asks for the exact confirmation phrase, then fetches a fresh timestamp and immediately submits the combined testnet deploy-and-init transaction. Use `-Execute` only after explicit authorization; never reuse a stale generated JSON file.
- The proposed members and payout order are `ajotest1.testnet`, `ajotest2.testnet`, and `ajotest3.testnet`. Verify that all three accounts exist and have sufficient NEAR for their 1 NEAR contribution plus gas. The constructor requires unique members, a one-to-one payout order containing those members, a positive contribution, and a deadline in the future. `round_deadline` is an absolute block timestamp in nanoseconds, not a duration; for round 1, calculate the 15-minute deadline as a fresh latest block timestamp plus `900_000_000_000` nanoseconds immediately before the combined deploy-and-init transaction, then submit promptly. Later deadlines may be shortened by the treasurer.
- Proposed demo contribution: `1 NEAR` per member per round (`10^24` yoctoNEAR). The contract accepts native NEAR deposits, not stablecoin-denominated contributions. The fiat value of a contribution and pot changes with NEAR's market price; collateral ratios measured in NEAR do not promise a stable USD value. Do not claim stable-dollar protection. A fungible-token contribution path and any swap/Intents flow are future work, not implemented by this contract.
- The selected mode is `ProtectedPublic`, so reserve funding and guarantee claims are available subject to the contract rules. The first demo uses the reserve route, not guarantees. If a later demo uses a guarantee, the contract requires `3 NEAR` of locked collateral per guaranteed member for a three-member circle contributing `1 NEAR` each; this is separate from the member contribution pot. No guarantee is automatic just because a deadline passes.

## First testnet demo plan

- Use the reserve route first; do not start the guarantee route in this run. With three members contributing 1 NEAR each, a single missed contribution requires at least `1 NEAR` in protection reserve to cover the shortfall. Reserve funding is separate from member contributions and must be explicitly authorized and sent by its funder.
- Planned defaulter: `ajotest3.testnet`. Planned first payout recipient: `ajotest1.testnet`. The intended scenario is that members 1 and 2 contribute 1 NEAR, member 3 misses the deadline, the reserve covers the 1 NEAR shortfall, and the treasurer releases the 3 NEAR pot to member 1. No funding or transactions are authorized by this plan.

## Trusted-operator and key-recovery disclosures

- The configured treasurer agent can trigger `release_payout` and `advance_round`; `advance_round` accepts a new future deadline, so the treasurer can change round deadlines within contract rules.
- The selected treasurer ID `ajocircle.testnet` is the same account as the contract account. This is intentional for the current **single-operator prototype**, not a neutral or independent treasurer design: the same account key can upgrade the contract and trigger payouts/advance rounds. Keep this limitation visible in demos and documentation.
- The full-access key can authorize contract upgrades and other account actions allowed by NEAR. Keep it for now so recovery/upgrades remain possible. Restrict who can access it, never commit or paste key material, and document a recovery owner, secure backup location, rotation procedure, and explicit approval requirement for upgrades. Do not delete or rotate it until an independently tested upgrade/recovery path is agreed. A later locked-contract demo should happen only after the contract is stable and the loss of upgrade/recovery ability is understood.
- The contract remains an unaudited prototype for testnet demonstration only. Do not use real funds or describe native-NEAR amounts as dollar guarantees.

### Planned work

1. Contract tests currently pass locally; re-run the WASM release build after each contract change.
2. Expand adversarial tests for guarantee expiry, concurrent transfer callbacks, and reserve-accounting invariants.
3. `settlement-adapter/` now includes a Node.js 1Click status client that requests swap status and fails closed unless status is `SUCCESS`, the original deposit address, recipient, destination asset, minimum output amount, and destination transaction evidence match a trusted stored quote. Offline tests cover the response checks. The live API has not been exercised and this adapter is not connected to the app, a database, or the contract; next add durable atomic replay protection and end-to-end test infrastructure.
4. Persist verified reputation events on-chain and connect the deterministic scoring rules to those events.
5. Add the treasurer agent with narrowly scoped permissions and auditable decisions, then build the member dashboard and deployment scenarios.

## Safety principles

- Contract state is authoritative for contributions and payouts.
- A transaction being initiated is not proof that a cross-chain contribution has settled.
- The treasurer cannot bypass contract-enforced rules.
- Collateral, reserve funds, and guarantees must be verifiable and must not be counted more than once.
- A payout must pause when verified protection for outstanding obligations is insufficient.

## Development

The NEAR smart contract is in [`contract/`](contract/). Follow the Rust and NEAR SDK versions in `contract/Cargo.toml` when setting up the build environment.

Before any redeployment, run the contract tests, review the payout and callback logic, and obtain an independent security review. The hardened testnet redeployment/initialization and cross-chain settlement integration are not yet complete.

## License

License selection is pending. Do not assume the project is open source until a license is added.

## Application identity and trusted context (prototype)

`settlement-adapter/application-store.mjs` adds a persistent SQLite repository for server-managed circle metadata, auth-provider principal mappings, circle memberships, rounds, approved origin assets, amount limits, and registered refund addresses. It implements the repository interface consumed by `application-context-adapter.mjs`. See `settlement-adapter/APPLICATION_CONTEXT_INTEGRATION.md` and `settlement-adapter/APPLICATION_STORE.md` for the integration contract, schema, and trust boundaries.

The repository is a real local persistence component, **not** a deployed production database or a complete application backend. Authentication remains external and unintegrated; the principal ID must come from verified session/token middleware. Circle/round metadata must be synchronized with and reconciled against the NEAR contract. Provisioning methods are privileged server-side operations and must never be exposed directly to browser clients.

Focused tests: `node --test settlement-adapter/application-context-adapter.test.mjs settlement-adapter/application-store.test.mjs`. The full Node settlement-adapter test suite runs with `node --test settlement-adapter\*.test.mjs` in PowerShell.
