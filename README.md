# Ajo Circle

A rotating savings circle built on NEAR Protocol, designed for transparent contributions, controlled payouts, and cross-chain participation.

## Project status

Ajo Circle is under active development. The current contract is an initial prototype; it is not audited and should not be used to custody real funds. See the [judge quickstart](JUDGE_QUICKSTART.md) for reproducible commands and historical testnet evidence, the [demo runbook](DEMO_RUNBOOK.md) for a truthful recording plan, and the [NEAR Hackathon 2026 submission checklist](HACKATHON_SUBMISSION_CHECKLIST.md) for submission requirements and release blockers.

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

- The original deployment `ajocircle.testnet` (transaction: `8H7VUVR3grQshyfGK8oyrx52MCZu3yt7DtXhgwsYfdK1`) is a separate, older instance and must remain untouched.
- **Recorded testnet demo evidence (25 October 2026; historical evidence, not a claim about current live state):** the payout plan for `ajo-demo-fresh.testnet` is recorded as `FINALIZED` for round index `2`, with a successful `release_payout` transaction of `3 NEAR` to `ajotest3.testnet`. Transaction hash: `HSCMVxa7ZcSSYsGaoA9rAcxWCSMD23uHVqbRycoctHT3`. The supplied finality record says `payoutComplete = true` and `circleCompleted = true`. See [the recorded testnet payout evidence](TESTNET_PAYOUT_EVIDENCE_2026-10-25.md). This is testnet evidence only; do not resubmit the payout.
- **Historical deployment:** `ajo-demo-oct21.testnet` (deployment transaction: `7ma22NzNyb6fSdLjMjKU8dAgx1SvBct7J3wkfwDX5gyA`) is an older, separate instance. Its previously recorded code SHA-256 was `58AAFA50AD444F3EAE60C5331B89BA2BA067F0E88EB3EAD7718A9550DC8B7DC7`; its old round-0 deadline and state are historical and must not be presented as the current demo state.

### Historical deployment recovery notes (not current deployment instructions)

- The old `ajo-demo-oct21.testnet` round had an expired deadline and insufficient reserve for its missing contributions. Do not treat that old state as the current demo or bypass contract rules to recover it. `advance_round` requires a successful payout first, while a protected payout with three missing contributions requires enough reserve to cover the 3 NEAR shortfall. With zero contributions and an empty reserve, do not attempt to recover this round by bypassing contract rules; use a fresh deployment after signer access and initialization arguments are verified.
- The current `deploy-init-testnet.ps1` preflight targets `ajocircle.testnet`, not `ajo-demo-oct21.testnet`. Do **not** run its `-Execute` path for the fresh demo account without reviewing and adapting the account-specific checks first. Any deploy-and-initialize transaction must use the intended contract account's own authorized key so `predecessor_account_id == current_account_id`; do not use an outsider signer.
- `deploy-init-testnet.ps1` runs read-only testnet preflight and a dry run by default: it verifies the pushed source/documentation commit, expected WASM SHA-256, empty contract storage, member balances, and the `ajocircle.testnet` keychain public key against its on-chain FullAccess key. It then fetches a fresh finalized block timestamp, generates a 15-minute initialization JSON in the system temp directory, and prints the exact near-cli-rs command. The default run sends no transaction. `.\deploy-init-testnet.ps1 -Execute` repeats the checks, asks for the exact confirmation phrase, then fetches a fresh timestamp and immediately submits the combined testnet deploy-and-init transaction. Use `-Execute` only after explicit authorization; never reuse a stale generated JSON file.
- The proposed members and payout order are `ajotest1.testnet`, `ajotest2.testnet`, and `ajotest3.testnet`. Verify that all three accounts exist and have sufficient NEAR for their 1 NEAR contribution plus gas. The constructor requires unique members, a one-to-one payout order containing those members, a positive contribution, and a deadline in the future. `round_deadline` is an absolute block timestamp in nanoseconds, not a duration; for round 1, calculate the 15-minute deadline as a fresh latest block timestamp plus `900_000_000_000` nanoseconds immediately before the combined deploy-and-init transaction, then submit promptly. Later deadlines may be shortened by the treasurer.
- Proposed demo contribution: `1 NEAR` per member per round (`10^24` yoctoNEAR). The contract accepts native NEAR deposits, not stablecoin-denominated contributions. The fiat value of a contribution and pot changes with NEAR's market price; collateral ratios measured in NEAR do not promise a stable USD value. Do not claim stable-dollar protection. A fungible-token contribution path and any swap/Intents flow are future work, not implemented by this contract.
- The selected mode is `ProtectedPublic`, so reserve funding and guarantee claims are available subject to the contract rules. The first demo uses the reserve route, not guarantees. If a later demo uses a guarantee, the contract requires `3 NEAR` of locked collateral per guaranteed member for a three-member circle contributing `1 NEAR` each; this is separate from the member contribution pot. No guarantee is automatic just because a deadline passes.

## Historical first-testnet-demo plan (superseded; do not treat as current state)

- Use the reserve route first; do not start the guarantee route in this run. With three members contributing 1 NEAR each, a single missed contribution requires at least `1 NEAR` in protection reserve to cover the shortfall. Reserve funding is separate from member contributions and must be explicitly authorized and sent by its funder.
- Planned defaulter: `ajotest3.testnet`. Planned first payout recipient: `ajotest1.testnet`. The intended scenario is that members 1 and 2 contribute 1 NEAR, member 3 misses the deadline, the reserve covers the 1 NEAR shortfall, and the treasurer releases the 3 NEAR pot to member 1. No funding or transactions are authorized by this plan.

## Trusted-operator and key-recovery disclosures

- The configured treasurer account can trigger `release_payout` and `advance_round`; `advance_round` accepts a new future deadline, so the treasurer can change round deadlines within contract rules.
- For the current payout demo, `ajo-demo-fresh.testnet` is both the contract account and the configured treasurer. On 25 October 2026, the local CLI keychain public key was reported to match an on-chain FullAccess key. Recheck this relationship before any future transaction; a matching public key does not justify exposing or exporting private-key material.
- This is a **single-operator prototype**: the contract account's FullAccess key can authorize account-level actions, including upgrades, as well as the contract's treasurer actions. Restrict machine access, never commit or paste key material, and document a recovery owner, secure backup location, rotation procedure, and explicit approval requirement for upgrades. Do not delete or rotate the existing credential until an independently tested recovery path is agreed.
- The contract remains an unaudited prototype for testnet demonstration only. Do not use real funds or describe native-NEAR amounts as dollar guarantees.

### Remaining work before a credible public demo

1. Re-run the contract tests and build the release WASM after any contract change. The fresh local regression run on 28 October 2026 passed all 65 Rust contract tests.
2. Obtain an independent security review of payout callbacks, reserve accounting, upgrade authority, and the single-operator treasurer model. The prototype is not audited.
3. The 1Click-related modules have offline validation tests, but live-provider behavior and a complete end-to-end cross-chain contribution flow have not been demonstrated. Do not claim cross-chain settlement is complete based only on quote/status modules.
4. Reputation scoring and verified-event ingestion exist in the application layer, but a complete persistent on-chain reputation history and end-user reputation product are not implemented.
5. The AI treasury agent is planned, not implemented. Keep it out of feature-complete claims until its permission model, auditable decisions, and tests exist.
6. Complete real-wallet interoperability checks and end-to-end testing against the actual configured testnet server, then review the full diff before selecting files for a public commit.

## Safety principles

- Contract state is authoritative for contributions and payouts.
- A transaction being initiated is not proof that a cross-chain contribution has settled.
- The treasurer cannot bypass contract-enforced rules.
- Collateral, reserve funds, and guarantees must be verifiable and must not be counted more than once.
- A payout must pause when verified protection for outstanding obligations is insufficient.

## Development

The NEAR smart contract is in [`contract/`](contract/). Follow the Rust and NEAR SDK versions in `contract/Cargo.toml` when setting up the build environment.
### Local verification (Windows PowerShell)

Run from the repository root. These checks do not deploy contracts or submit blockchain transactions.

```powershell
# Full JavaScript settlement-adapter suite
node --test settlement-adapter\*.test.mjs

# Rust contract and settlement-adapter suites (offline)
cargo test --manifest-path contract\Cargo.toml --offline
cargo test --manifest-path settlement-adapter\Cargo.toml --offline

# Frontend production bundle
Push-Location web
npm ci
npm run build
Pop-Location

git diff --check
```

Fresh verification on 28 October 2026: **384 JavaScript tests passed**, **65 Rust contract tests passed**, **7 Rust settlement-adapter tests passed**, and `npm run build` passed (Vite transformed 26 modules). `git diff --check` passed with line-ending conversion warnings only. These results verify the current local worktree, not a clean public checkout, real-wallet interoperability, production deployment, or an independent security audit. Re-run checks after changes and before publishing.

For frontend/API architecture, local testnet setup, and wallet-testing limitations, see [`web/README.md`](web/README.md). Keep server-only credentials out of `web/` and all `VITE_` variables. The frontend is a testnet prototype: the member can explicitly confirm a wallet-authorized native-NEAR testnet contribution, and guarded payout paths may submit testnet transactions after separate server-side checks and confirmations. Quote creation or swap delivery is not proof of a contract contribution.

Before any redeployment, run the contract tests, review the payout and callback logic, and obtain an independent security review. The hardened testnet redeployment/initialization and cross-chain settlement integration are not yet complete.

## License

License selection is pending. Do not assume the project is open source until a license is added.

## Application identity and trusted context (prototype)

`settlement-adapter/application-store.mjs` adds a persistent SQLite repository for server-managed circle metadata, auth-provider principal mappings, circle memberships, rounds, approved origin assets, amount limits, and registered refund addresses. It implements the repository interface consumed by `application-context-adapter.mjs`. See `settlement-adapter/APPLICATION_CONTEXT_INTEGRATION.md` and `settlement-adapter/APPLICATION_STORE.md` for the integration contract, schema, and trust boundaries.

The application store is local SQLite, **not** a deployed production database. The combined loopback-only `settlement-adapter/ajo-testnet-app-server.mjs` composes NEP-413 challenge/sign/verify routes, short-lived bearer sessions, trusted membership and quote-context resolution, settlement metadata, and guarded testnet workflows. It remains a development/testnet backend rather than a production service. Circle membership and wallet verification must be established through trusted server-side operations; there is no public membership-provisioning endpoint. Never expose privileged provisioning methods directly to browser clients.

Focused tests: `node --test settlement-adapter/application-context-adapter.test.mjs settlement-adapter/application-store.test.mjs`. The full Node settlement-adapter test suite runs with `node --test settlement-adapter\*.test.mjs` in PowerShell.

## 1Click quote integration safety

See [the 1Click setup and credential guide](settlement-adapter/ONECLICK_SETUP.md) before configuring any provider credential. The active app is a NEAR testnet prototype; 1Click is a live service, and committed quotes can return real deposit instructions. Do not configure a live token in this testnet environment merely to test connectivity.
