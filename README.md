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

Before deploying, run the contract tests, review the payout and callback logic, and obtain an independent security review. Deployment and cross-chain settlement integration are not yet complete.

## License

License selection is pending. Do not assume the project is open source until a license is added.
