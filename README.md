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
- Keep unclaimed collateral locked. There is still no safe collateral-release path or terminal-circle lifecycle, and guarantee expiry must be planned carefully for the circle's intended duration.
- Permit a protected public payout to cover missing contributions only after the deadline and only when the reserve covers the exact shortfall; otherwise the payout pauses.
- Reserve the shortfall while a payout is pending, keep the deduction after success, and restore it if the transfer callback reports failure.
- Restrict payout initiation and round advancement to the configured treasurer account.
- Mark a payout complete only after its transfer callback reports success.
- Expose round, contribution, mode, current shortfall requirement, protection balance, and pending reserve-use views.

### Planned work

1. Contract tests currently pass locally; re-run the WASM release build after each contract change.
2. Add a safe protection-deposit release policy, terminal-circle handling, and explicit reserve replenishment rules; expand adversarial tests for round transitions and accounting invariants.
3. Design the NEAR Intents settlement adapter so a cross-chain contribution is credited only after settlement is independently verified.
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
