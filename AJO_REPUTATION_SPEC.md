# Ajo Circle — Reputation and Circle Discovery Design

## Product decision
Trust scores are public by default. A member can see their own record, and public-circle organizers can search for circles and define eligibility rules. Privacy controls may later let members limit optional profile details, but must not misrepresent the public-score default.

## Member reputation profile
- Public trust score: 0–1,000, calculated from published, versioned rules.
- Verified activity counters: completed rounds, on-time contributions, late contributions, missed contributions, completed circles, and confirmed defaults.
- Record timestamps and evidence references for score-affecting events.
- Correction/dispute state; disputed events are visibly marked and reviewed before irreversible penalties.
- Score is a platform-specific history signal, not a guarantee of future repayment or a universal credit rating.

## Scoring principles
- Only verified contract events and validated settlement records affect the score.
- Publish the formula and version; score changes must be reproducible from the underlying events.
- Do not let an AI model directly invent events or silently alter scores. The agent may flag anomalies; deterministic rules and authorized review apply changes.
- Avoid double-counting the same contribution event. Define how late payments later cured, cancellations, force majeure, and disputes affect scoring.
- Sybil resistance and identity assurance are separate concerns; one wallet is not proof of one human.

## Circle discovery and eligibility
A searchable listing exposes contribution amount/asset, cadence, member capacity, payout order, circle mode, fees, collateral/reserve policy, and required reputation thresholds. Organizers may configure minimum score, minimum completed circles, maximum verified defaults, and other objective criteria. Eligibility is checked at join time and rechecked only under disclosed rules.

## Circle modes
- Private: trusted invite-only group; may explicitly choose no collateral/buffer after acknowledging the risk.
- Protected public: open discovery with disclosed reputation thresholds and mandatory, verifiable payout protection.
- Custom: organizer configures allowed rules within protocol safety limits.

## Money and safety invariants
- A high score is not collateral and must never be counted as funds.
- Public-circle payouts pause when verified protection is below the required outstanding exposure.
- Do not double-count a reserve, collateral, guarantee, or funds already committed elsewhere.
- Cross-chain contributions count only after an authenticated NEAR Intents settlement result is verified by the contract's authorized integration; client-side claims are insufficient.
- Fees are disclosed before joining, use fixed or capped parameters, go to a separately identified treasury, and cannot change mid-cycle without the disclosed consent process.

## Implementation sequence
1. Keep this document as the product contract; back up existing files before code changes.
2. Add tested Rust types and deterministic scoring/eligibility helpers, then unit tests for boundaries and invalid configuration.
3. Add event-backed reputation records and views, with bounded storage and versioned scoring.
4. Add searchable frontend listings and clear explanations of score, fees, and protection.
5. Integrate the AI agent as a monitor/advisor, not the authority over funds or score facts.
6. Integrate NEAR Intents only after settlement verification and replay protection are designed and tested.
7. Audit access control, privacy, sybil resistance, reserve accounting, payout invariants, and deployment configuration before real funds.

## Current status
This is a design specification, not a complete or audited product. The Rust prototype has `Private`/`ProtectedPublic` modes and an initial tested reserve-accounting path: after the contribution deadline, a protected public payout may use the separately tracked reserve to cover the exact amount of missing contributions. The amount is reserved while the transfer is pending, retained after reported success, and restored after reported failure. Payout pauses when the reserve is insufficient. This is not yet a complete protection product: there is no safe release/withdrawal path, no explicit reserve replenishment policy, no terminal-circle state, and no independently verified default/claim adjudication. The prototype's stage-one contribution and payout model remains limited. Reputation is still pure logic rather than persistent verified on-chain history. Do not use real funds until these gaps, settlement integration, adversarial tests, and an independent security review are complete.
