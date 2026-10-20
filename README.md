# Ajo Circle

A rotating savings circle built on NEAR Protocol, designed for transparent contributions, controlled payouts, and cross-chain participation.

## Project status

Ajo Circle is under active development. The current contract is an initial prototype; it is not audited and should not be used to custody real funds.

### Reputation and discovery

`AJO_REPUTATION_SPEC.md` defines the public-by-default trust profile, searchable circle eligibility, circle modes, transparent fee rules, and payout-protection invariants. The contract now includes a pure Rust reputation module with a deterministic 0–1,000 score and eligibility checks. These helpers are not yet wired to persistent, verified on-chain member histories or the frontend; they are an initial tested component, not a complete reputation product.

## Current contract scope

- Create a circle with a fixed member list, contribution amount, payout order, deadline, and treasurer account.
- Accept one exact-size NEAR deposit from each member per round before the deadline.
- Restrict payout initiation and round advancement to the configured treasurer account.
- Mark a payout complete only after its transfer callback reports success.
- Expose basic round and contribution views.

### Planned work

1. Establish a reproducible contract build and test suite.
2. Add an explicit payout safety gate for secured collateral, reserves, and remaining member obligations.
3. Design the NEAR Intents settlement adapter so a cross-chain contribution is credited only after settlement is independently verified.
4. Add the treasurer agent with narrowly scoped permissions and auditable decisions.
5. Build the member dashboard, deployment instructions, and test scenarios.

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
