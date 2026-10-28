# AjoCircle Circle Policy Specification

## Status and safety boundary

This is the product policy for the AjoCircle prototype milestone. Local policy functions, SQLite policy records, authenticated local circle creation, policy preview/join/invitation, cycle schedule configuration, cycle status/start endpoints, the all-member acceptance gate, and member-facing setup UI are implemented locally. A read-only NEAR testnet contract-verification endpoint now checks deployed WASM SHA-256 against the approved hash, checks policy mode, reads finalized lifecycle views, and stores creator-authorized contract-binding evidence. It does not deploy or mutate a contract. Quote-context resolution remains fail-closed for UI-created circles because the approved contract ABI does not expose enough immutable configuration to prove the local schedule matches on-chain settings. These controls do not execute transfers, enforce an on-chain vote, or independently verify event history. Public discovery and the verified-reputation dashboard remain future work. Existing deployments are unchanged.

## Circle modes

### Protected public circle

- Publicly discoverable, subject to the platform's listing and eligibility rules.
- This is a **whole-circle completion model**, not the private circle's round-by-round rotating payout model. Contributions and outstanding obligations must remain visible throughout the cycle.
- Do not distribute a rotating round payout or claim that the circle is complete before the published completion condition is met: every non-removed member has completed the required contributions, and any default/removal cases and disputes have been resolved under the published policy.
- Once the circle reaches that completion condition, distribute the final distributable pool among eligible members **in proportion to each eligible member's verified contribution total**. Equal division is not the default.
- The proportional allocation formula is `memberShare = distributablePool * memberVerifiedContributions / totalVerifiedContributionsOfEligibleMembers`, calculated in integer base units. To handle indivisible remainder units, use a deterministic largest-remainder allocation; ties are broken by member account ID in ascending lexical order. Every unit must be allocated exactly once.
- The `distributablePool` must be established from the authoritative ledger after separately approved obligations and settlements. Do not automatically subtract the 5% default penalty from all members or treat a proposed penalty as collected funds. A removal penalty applies only to an approved removal case after review is cleared.
- Only eligible members with verified contribution totals participate in this distribution. Removed members' refund/penalty cases are reconciled separately; do not count money already refunded, penalized, or otherwise distributed twice.
- This formula and the eligible-member rules must be disclosed and accepted before the cycle starts. If contribution weights, pool balance, or eligible-member status cannot be verified, block distribution and report the discrepancy.
- The current proposed removal penalty is fixed at 5% (500 basis points) of the eligible refundable balance after valid obligations are accounted for.
- A missed deadline starts a published grace period. Five days is an example/default candidate, not a final global setting; the chosen duration must be displayed and accepted before launch.
- A member who has not cured after grace may become eligible for a removal vote; missed payment or grace expiry alone does not remove the member.
- The vote must be validated against the circle's published quorum, threshold, voter eligibility, and conflict rules before it is considered approved. The AI may notify, summarize evidence, and explain the rules, but must not vote, remove a member, or authorize a transfer on its own.
- Hardship review or an open dispute blocks final settlement. The penalty calculation requires an approved vote and cleared review.
- Do not send a partial pot or claim protection unless the required protection is actually available and verified.

### Private trusted circle

- Invitation-only and excluded from public discovery.
- The invitee must review and accept the current policy before joining.
- This is the **round-by-round rotating payout model**: members contribute according to the agreed schedule, and the designated recipient for a round receives that round's pot only after the round's required contributions are verified and the published payout checks pass.
- No platform-funded collateral, guarantee, mandatory protection reserve, or loss protection is promised by default. Members may agree to additional rules, but those rules must be disclosed and accepted before the cycle starts.
- The default shortfall rule is to wait until the full round pot is collected. A creator may choose partial payout only if that choice is explicitly disclosed and accepted by all required participants before the cycle starts.
- If the pot is short, show the amount collected and exact shortfall; do not mark the round complete or imply the full pot was paid.
- A later payment must be allocated against the recorded obligation and remaining payout entitlement exactly once.
- Follow the accepted payout order and do not silently convert a private circle into the public whole-circle completion model.

## Policy acceptance and versioning

- Every circle policy is stored as an immutable version and receives a SHA-256 hash of its canonical policy representation.
- Acceptance is recorded against the exact policy version and hash. Joining through the policy-aware repository method requires explicit acceptance of the latest published version.
- Policy versions are sequential. Policy cannot be changed after round records have been configured. A material rule change must not silently rewrite an active cycle's accepted terms.
- Private invitation links use cryptographically random tokens, expiry, use limits, revocation, and token-hash storage. Preview does not consume a use; joining consumes a use atomically. The UI places the token in the URL fragment so it is not sent in the HTTP request path.

## Proposed protected-circle default lifecycle

1. `NOT_DUE`: deadline has not passed.
2. `GRACE_PERIOD`: deadline passed but the published grace period has not expired.
3. `ELIGIBLE_FOR_VOTE`: grace expired, no cure exists, and no open review/dispute blocks the vote.
4. `VOTE_PENDING`: a removal vote has been opened; no penalty may be finalized.
5. `REMOVED_PENDING_REVIEW`: the vote has been validated and approved; review/dispute still must be resolved.
6. `SETTLEMENT_READY`: review is cleared and the refund/penalty calculation has been checked against the authoritative ledger.
7. Terminal result: settlement recorded once, or the case closed without removal/penalty.

The local `assessDefaultCase` helper models the deadline/grace/eligibility decision. The full state machine, vote ledger, authorization, and on-chain enforcement are not implemented.

## Refund and penalty accounting

- Use integer base units only.
- `eligibleRefundableBalance = max(grossRefundableBalance - validObligations, 0)`.
- `penaltyAmount = floor(eligibleRefundableBalance * 500 / 10000)`.
- `memberRefund = eligibleRefundableBalance - penaltyAmount`.
- A treasury credit is recorded as pending accounting until a separately authorized settlement succeeds; calculating a penalty never authorizes or initiates a transfer.
- Reconcile payouts, contributions already distributed, collateral, reserve balances, guarantees, valid obligations, refunds, and prior penalties separately. Never count a previously distributed contribution as cash on hand.
- If the authoritative ledger cannot establish an available refund, report that limitation rather than promising a full refund.

## Member dashboard and reputation

The local `buildMemberReputationProfile` helper projects verified canonical obligation outcomes into:

- scheduled payments, payments made, payment rate, and on-time rate;
- on-time and late payments, cured defaults, missed payments, and confirmed defaults;
- completed rounds, pots received, and completed circles;
- versioned trust score from 0 to 1,000, matching the current Rust reputation formula.

Only records explicitly marked verified are included. Duplicate event IDs and duplicate canonical obligation IDs are rejected. A cured default counts as a late payment for the current score while remaining visible as a separate counter. An empty history scores 500 and shows rates as unavailable, not 0%. The score is a history signal, not a guarantee of repayment. This projection does not yet fetch or independently verify live contract events.

## Read-only contract configuration views (local source only)

- The Rust contract source now exposes `get_members`, `get_member_count`, `get_contribution_amount`, `get_payout_order`, and `get_treasurer_agent`; existing `get_mode` and `get_round_deadline` complete the relevant configuration reads.
- Unit test `exposes_immutable_circle_configuration_for_schedule_verification` checks the returned member list/count, contribution amount, payout order, deadline, treasurer, and mode. `cargo test` passed 39 tests; `cargo fmt -- --check` passed.
- The settlement-adapter verifier now requests and validates these views, including unique members, exact member count, positive contribution amount, a unique payout order covering all members, a valid treasurer account, and current-recipient/payout-order consistency. It reports the configuration but deliberately keeps `quoteReady=false` until local/on-chain parity comparison is implemented.
- Local release WASM SHA-256: `9CEEF205D2FAC59DB2C5B4B5E3FD4EE49E75B6371682B2872EF93CBC2C852E06` (267,910 bytes). This is a locally built artifact only; it has not been deployed or added to the approved deployed-code allowlist. Existing deployed contract remains unchanged and does not yet expose these new views.
- No deployment, initialization, transaction, contribution, payout, or funds movement occurred.

## Required tests before integration

- Grace-period boundaries, cure, dispute, hardship review, valid vote quorum/threshold/eligibility, replay, and expired vote.
- No penalty before approved removal and cleared review; no duplicate settlement after retry.
- Refund calculation, obligations exceeding balance, zero/tiny amounts, integer rounding, and no double-counting.
- Immutable policy versions and acceptance bound to the current policy hash.
- Private invitation token expiry/revocation, private-circle exclusion from discovery, and invitation replay.
- Full-pot versus explicitly permitted partial-pot handling; no round completion on a short pot.
- Verified-only reputation aggregation, corrected/disputed records, duplicate events, and empty-history behavior.
- Authorization, persistent storage, concurrency, migrations, contract-level tests, and independent security review.

## Implementation status

- Implemented locally: deterministic policy validation, grace-period eligibility, penalty/refund calculation proposal, private payout shortfall calculation, verified-record reputation projection, SQLite policy versions and hashes, explicit acceptance records, authenticated local circle creation against a caller-supplied contract ID, creator-only schedule configuration, policy-aware join, private invitation creation/preview/expiry/use limits/revocation, authenticated policy/join/invitation/cycle-status/cycle-configure/cycle-start/contract-verification endpoints, approved-code-hash verification against finalized NEAR testnet code, policy-mode and lifecycle-view checks, persistent creator-authorized contract binding, round-schedule validation, a start gate requiring every active member to accept the exact policy hash, quote-context blocking until the deployed contract schedule can be matched, and member-facing circle setup/policy/invitation/cycle-readiness/contract-verification UI.
- Cycle start requires the creator, unchanged policy version/hash, active member count equal to planned rounds, acceptance by every active member, and all rounds configured consecutively with matching contribution amounts and strictly increasing deadlines. Once started, membership and round configuration are locked by the application store.
- Verified live on testnet (read-only): `ajo-demo-oct21.testnet` returned the approved SHA-256 `58aafa50ad444f3eae60c5331b89ba2ba067f0e88eb3ead7718a9550dc8b7dc7`, mode `ProtectedPublic`, round 0, 0 contributions, and no pending/completed payout. This verifies code hash and the queried public state only; it does not prove schedule parity or reserve solvency.
- Tested locally: all 147 settlement-adapter tests pass; the Vite production build succeeds; `git diff --check` reports no whitespace errors (only LF/CRLF conversion warnings).
- Not implemented: on-chain contract deployment, exact local/on-chain schedule matching needed to unlock quotes, public circle discovery/listing, a connected verified-reputation dashboard, durable verified obligation/event ingestion, on-chain default voting/removal, refund/penalty transfers, full payout-protection integration, or independent security/legal review.
- No deployment, transaction, or funds movement is authorized by this specification.
