# AjoCircle — NEAR Hackathon 2026 Submission Checklist

**Prepared:** 25 October 2026
**Project repository:** https://github.com/Is-tomsti/AjoCircle
**Current demo network:** NEAR testnet only

## Official submission requirements

The official [NEAR Hackathon website](https://nearhackathon.com/) currently says the **submission window opens 1 November 2026 at 00:00 UTC** and closes **14 November 2026 at 23:59 UTC**. November 1 is the submission-opening date, not a date to wait until before preparing AjoCircle. The event page also describes the hackathon build period as November 1–14; continue preparing the existing project now and aim to submit promptly when submissions open. It asks each team to publish a public repository, publish a public demo post on X that says the project was built at NEAR HACKATHON and includes a demo video or screenshots, then submit both links. One submission per team.

Recheck the official page before submitting in case the rules change.

## Checklist

- [ ] Review the official tracks and choose the best fit for AjoCircle. Social Money appears relevant to community savings circles; confirm track options on the live form and select every track that genuinely fits.
- [ ] Review the repository for secrets, private keys, tokens, local databases, personal data, temporary backups, and machine-specific files. Never commit secret material.
- [ ] Resolve the project license choice. README currently says license selection is pending; do not describe the repository as open source until an appropriate license is added.
- [ ] Refresh README setup/run instructions and accurately distinguish implemented features from planned work.
- [ ] Verify a clean install/build and rerun automated tests on the exact candidate commit.
- [ ] Verify the public GitHub repository is accessible without login and contains the intended code/docs.
- [ ] Record a short, truthful demo showing the actual working UI and the testnet payout evidence. Avoid implying that unimplemented AI treasury, full cross-chain contribution, or production security is complete.
- [ ] Publish the demo on X as a public post, say it was built at NEAR HACKATHON, and attach the demo video or screenshots.
- [ ] Copy the public repository URL and public X demo-post URL into the official submission form before the deadline.
- [ ] Save the final submission confirmation and links in the project documentation.

## Verified development checks (25 October 2026)

- **Fresh run on 28 October 2026:** Node settlement-adapter test suite: **384 passed, 0 failed**.
- **Fresh run on 28 October 2026:** Rust contract tests (offline): **65 passed, 0 failed**.
- **Fresh run on 28 October 2026:** Rust settlement-adapter tests (offline): **7 passed, 0 failed**.
- **Fresh run on 28 October 2026:** frontend production build passed (Vite transformed 26 modules).
- **Fresh run on 28 October 2026:** `git diff --check` exited 0; Git emitted line-ending conversion warnings only.
- Round 2 payout evidence is recorded in [TESTNET_PAYOUT_EVIDENCE_2026-10-25.md](TESTNET_PAYOUT_EVIDENCE_2026-10-25.md). It reports a successful 3 NEAR payout to `ajotest3.testnet` and a finalized completed-circle state on testnet.

These checks do not replace fresh on-chain verification, wallet interoperability testing, an independent security review, or an end-to-end public demo test.

## Current product truth to preserve in the pitch

AjoCircle is a NEAR smart-contract-based rotating savings-circle prototype for transparent contribution tracking and ordered payouts, with protected-public circle logic and testnet payout lifecycle evidence. The contract remains unaudited and must not be used to custody real funds.

Do not claim the following are complete unless new evidence proves it:
- AI treasury agent with production permissions and audit controls.
- Fully integrated cross-chain contribution settlement through NEAR Intents/1Click.
- Production-grade wallet authentication, abuse protection, monitoring, or deployment.
- Persistent on-chain reputation histories and a complete reputation product.
- Independent security audit.

## Suggested project description draft

AjoCircle is a NEAR-based rotating savings-circle prototype for Ajo/Esusu groups. It encodes member contributions, payout order, treasurer authorization, and payout-completion rules in a smart contract. Its protected-public mode tracks reserve funds separately and pauses payouts when verified protection is insufficient. The project includes a member-facing web prototype, a server-side settlement adapter with guarded testnet payout execution, schedule-parity checks, and automated contract and adapter tests. A testnet demo has recorded a finalized 3 NEAR payout and completed-circle state. The prototype is unaudited and does not handle real funds; broader cross-chain settlement, AI treasury automation, and persistent on-chain reputation remain future work.

Before using this draft, verify it fits the live form's character limit and revise it to match the exact demo you can show.

## Evidence links

- Official hackathon website: https://nearhackathon.com/
- Public repository: https://github.com/Is-tomsti/AjoCircle
- Public X demo post: **not yet published**
- Official submission: **not yet submitted**

## Update — 26 October 2026: reconciled public distribution and live requirements check

- Added [TESTNET_PUBLIC_DISTRIBUTION_EVIDENCE_2026-10-26.md](TESTNET_PUBLIC_DISTRIBUTION_EVIDENCE_2026-10-26.md), recording the supplied status endpoint response for a separate 9 NEAR testnet distribution plan. It reports `FINALIZED` / `COMPLETE`, 3 NEAR verified per member, distribution index 3, no pending transfers, and no transaction submitted during status reconciliation. Do not repeat the plan.
- Rechecked the [official NEAR HACKATHON site](https://nearhackathon.com/) on 26 October 2026. It confirms the **submission window opens 1 November 2026 at 00:00 UTC** and closes **14 November 2026 at 23:59 UTC**. Do not defer preparation until that date. The event page separately describes a two-week build period during November 1–14. Required: a public repository, a public X demo post explicitly saying the project was built at NEAR HACKATHON and including demo video or screenshots, and submission of both links. One submission per team; no wallet connection is required for submission. Track choices shown include Unstoppable DeFi, Investment Thesis, Privacy & Private AI, Autonomous Business, AI Swarms, AI Security & Defense, Agent Economy, Real-World Money, Games With Real Economies, NFTs That Do Something, Memecoins With Mechanics, Social Money, and Open Innovation. Choose only tracks that accurately match the finished prototype; re-evaluate the track before submission rather than assuming Social Money fits automatically.
- Official page: https://nearhackathon.com/ (checked 26 October 2026). Requirements may change; recheck on submission day.
- Current blocking release tasks remain: run/record full current test suite and frontend build, inspect secrets and backups before any public commit, resolve/add a license, verify README quickstart on a clean environment, confirm public repository contents, produce a truthful demo video/screenshots, publish the required X post, then submit both links. The public X post and official submission are still **not done**.

## Repository release audit update — 26 October 2026

### Completed safely

- Reviewed `.gitignore`. It already excludes `.env*` (except `.env.example`), logs, build targets, local NEAR credentials, local server configuration, local backups and selected inspection/recovery artifacts.
- Added ignore rules for the root-level `ajo-contrib-20261025-init.json`, `advance-round-round3-args.json`, and the `backup-public-distribution-*` / `backup-public-distribution-fix-*` recovery snapshots. Verified each is now ignored by Git. These files and folders were preserved on disk; nothing was deleted.
- Ran a heuristic scan over source, JSON, script, documentation and project config files for private-key markers and common hard-coded secret assignments. It returned no matches. This is not a complete secret audit; review staged files and run a dedicated scanner before public publication.
- `git diff --check` passed after the ignore-rule change; Git emitted only LF/CRLF conversion warnings.
- Confirmed `web/package-lock.json` exists. No repository root `package.json` was listed; frontend commands are defined in `web/package.json`.
- Reviewed `loadApprovedOriginAssets()` in `web/src/main.js`: selector is disabled initially; no session prevents loading; authenticated request uses the session bearer token; an empty result displays `ORIGIN_ASSET_ALLOWLIST_EMPTY` without guessing an asset ID; API errors leave the selector disabled. This is source review, not a successful real-wallet browser E2E test.
- Server code reads `AJO_TESTNET_ALLOWED_ORIGIN_ASSETS` and maps an unset value to an empty allowlist. The current PowerShell audit process has that variable unset; this does **not** prove the separately running API process has the same environment. Do not assume approved assets are configured. The server should remain fail-closed unless the live configuration is verified.

### Remaining publication blockers

- The worktree still contains extensive modified and untracked application/contract files. No broad staging is safe until each intended file has been reviewed.
- Several testnet deployment/migration/deadline scripts are untracked. Review their exact behavior and document that they are testnet-only before deciding whether they belong in the public repo.
- The license is still not selected and no `LICENSE`, `LICENSE.md`, or `COPYING` file is present.
- A clean install and real-wallet browser end-to-end flow have not yet been verified. The prior production build and tests passed, but that is not a substitute for clean-install/E2E validation.
- No commit or push was made. Do not publish until the final staged diff and sensitive-file checks pass.

## Release audit update — 28 October 2026 (fresh local verification)

### Completed in the existing worktree

- Fresh full JavaScript suite: `node --test settlement-adapter\*.test.mjs` — **384 passed, 0 failed**.
- Fresh offline Rust contract suite: **65 passed, 0 failed**.
- Fresh offline Rust settlement-adapter suite: **7 passed, 0 failed**.
- Frontend production build passed with Vite 8.3.4; 26 modules transformed.
- Clean-install check: copied only the frontend package manifest/lockfile, HTML, and source into a temporary directory outside the repository; `npm ci` and `npm run build` both passed there after removing an inherited `npm_config_allow_scripts` environment override in that test shell. The existing project `node_modules` and running app were not modified.
- Local HTTP smoke checks: frontend `GET http://127.0.0.1:5173/` returned HTTP 200; unauthenticated `GET /api/circle/assets/available` on `127.0.0.1:8787` returned HTTP 401, as expected for the authenticated route. These are not real-wallet E2E tests and do not prove a member can create a quote.
- A high-risk-pattern scan of non-ignored candidate files found no PEM private-key blocks, NEAR private-key strings, common GitHub/OpenAI/AWS/Slack token formats, or JWT-like literals. This heuristic is not a complete secret audit; inspect final intended public files and run a dedicated scanner before publishing. The broad preliminary scan produced false positives on ordinary documentation/tests mentioning private keys and tokens.
- Updated `README.md` with current test results, local verification commands, and a warning that the 25 October payout record is historical evidence rather than a claim about current live state.
- Updated the test-results section of this checklist with the fresh 28 October results.
- `git diff --check` exited 0; only Git LF/CRLF conversion warnings appeared.

### Live local services observed; do not interrupt

- The Vite dev server was already running on `127.0.0.1:5173` (PID observed: 456).
- The combined AjoCircle testnet API was already running on `127.0.0.1:8787` (PID observed: 1760).
- Do not stop/restart these user processes or replace their environment without explicit coordination. The current process environment/asset allowlist was not independently inspected; the unauthenticated route test only verifies that the API rejects unauthenticated access.

### Still blocking public release

- No actual real-wallet challenge/sign/verify E2E was performed in this pass; no verified membership/asset configuration or quote flow was asserted.
- No independent security audit has been performed; contract remains testnet-only and unaudited.
- License choice remains pending; do not publish as open source under an assumed license.
- The worktree contains extensive modifications and untracked files, including testnet operation scripts and recovery backups. Review the exact candidate file list and sensitive files before any staging. Do not broadly stage, commit, push, deploy, or submit without the user's explicit authorization.
- Public X demo post and official hackathon submission remain undone.

No blockchain transaction, deployment, migration, deadline change, commit, or push was performed during this release-audit pass.
## Oct24 contract parity investigation — 28 October 2026 (read-only)

- A finalized NEAR testnet `view_code` query at block height `275113121` confirmed that `ajo-demo-oct24.testnet` currently deploys 371,436 bytes with SHA-256 `D8026AD1DE87E1122ED1FE36578F2FE9BE1324F1ED4EF4BC576F8B4B1EE70CDF`, matching the approved hash already recorded in this handoff. This verifies code identity, not correct schedule readiness.
- Finalized view calls at block height `275113179` returned: mode `ProtectedPublic`; 4 members and 4 payout-order entries `[ajocircle.testnet, ajotest1.testnet, ajotest2.testnet, ajotest3.testnet]`; treasurer `ajo-demo-oct24.testnet`; contribution `1 NEAR`; current round `0`; contribution count `0`; no payout pending/completed; protection balance `0`; required protection `4 NEAR`.
- The live four deadlines are `1793168672388050870`, `1793169572388050870`, `1793170472388050870`, `1793171372388050870` nanoseconds.
- Read-only SQLite inspection of `%LOCALAPPDATA%\AjoCircle\ajo-application-testnet.sqlite` confirms the local `ajo-demo-oct24.testnet` binding has the same network, approved code hash, mode, members, payout order, treasurer, contribution amount, and four-round count. The only recorded parity mismatches are the four local round deadlines. Local deadlines are `1792717430870000000`, `1792739030870000000`, `1792760630870000000`, `1792782230870000000`; `quoteReady=0` and quotes are correctly blocked.
- The local circle UUID is `3c3e95af-530d-4441-8f91-e510bad85ec6`. The recorded creator wallet is `ajocircle.testnet`. The database reports 4 active members, all 4 accepted the current policy, and one creator record. Do not expose or alter member data beyond this diagnostic need.
- Existing authenticated UI action: **Import existing on-chain cycle (read-only)**, which posts to `/api/circle/cycle/import-verified`. The handler obtains fresh finalized verification, requires the creator wallet and active membership, checks policy acceptance and exact configured member/order/treasurer parity, then updates local cycle/round metadata from verified on-chain evidence. It submits no blockchain transaction. If the creator session is not authenticated, do not call the route with a fabricated token or bypass auth.
- The current on-chain round-0 deadline had already passed by the time of this check. Even after authenticated import reconciles the local deadlines, quotes must remain blocked because expired deadlines are intentionally fail-closed. A deadline-extension transaction would require separate explicit user authorization; do not submit it or any other transaction without that authorization.
- The older narrative describing a three-member schedule is historical and does not describe the current local Oct24 binding. Use the four-member/four-round facts above for further diagnosis.

No database writes, chain transactions, deadline changes, deployments, commits, or pushes were made during this investigation.
## Deadline-recovery script safety update — 28 October 2026

- The existing `recover-oct24-deadline-testnet.ps1` had an obsolete expected code hash (`164aa0…`) and, before this pass, would have proceeded to submit a transaction after its preflight with no explicit `-Execute` switch/phrase guard. I updated the expected hash to the independently verified and already allowlisted deployed hash `d8026ad1de87e1122ed1fe36578f2fe9be1324f1ed4ef4bc576f8b4b1ee70cdf`.
- Hardened the script so the default invocation stops after preflight and prints **DRY RUN ONLY**. Transaction submission now requires both `-Execute` and the exact phrase `EXTEND ajo-demo-oct24.testnet ROUND 0 DEADLINE TO 2026-10-29T12:00:00Z`. PowerShell parser validation reported zero syntax errors.
- Ran the script **without** `-Execute`; it reported `DRY RUN ONLY: read-only preflight passed; no transaction submitted` and exit code 0. No `near contract call ... send` was run by this invocation.
- At finalized block height `275113550`, block time was `2026-10-28T06:37:21.090Z`; the on-chain round-0 deadline `2026-10-28T06:24:32.388Z` was expired. The script's proposed deadline is `2026-10-29T12:00:00Z`, a shift of about 29.59 hours applied to the active and later deadlines. This is only a prepared proposal, not approval to submit it.
- The app's authenticated UI import is the next safe local reconciliation: sign in with the recorded creator wallet `ajocircle.testnet`, enter local circle ID `3c3e95af-530d-4441-8f91-e510bad85ec6` under **Cycle readiness → Circle ID for existing contract**, then click **Import existing on-chain cycle (read-only)**. This updates local metadata from fresh verified chain state and sends no transaction. After import, expired deadline protection should still block quotes. Do not share session tokens or wallet keys in chat.
- Do not run `recover-oct24-deadline-testnet.ps1 -Execute` unless the user explicitly authorizes this exact deadline-extension transaction. Do not use a direct SQLite edit to force parity.
## Public remote and visual smoke check — 28 October 2026

- Anonymous read-only `git ls-remote https://github.com/Is-tomsti/AjoCircle.git HEAD` succeeded. Public remote HEAD is `2eeab6b42cdbdae7ae061e6b4b681bb0b3cca72c`, matching the local `HEAD=2eeab6b` commit. This confirms the existing repository is reachable; it does **not** publish the current working-tree changes.
- Captured a temporary headless Edge screenshot of `http://127.0.0.1:5173/` for visual inspection at `%TEMP%\ajocircle-home-unauthenticated-20261028.png`. The unauthenticated sign-in/read-only UI rendered; this is not a wallet E2E or final hackathon demo asset and was not added to the repository.
- No files were staged, committed, or pushed.

## Official submission protocol verified — 28 October 2026

- Downloaded and reviewed the current official guide at https://nearhackathon.com/HACKATHON.md on 28 October 2026. The guide states submissions open 2026-11-01T00:00:00Z and close 2026-11-14T23:59:00Z; recheck the official page before submission.
- Required fields: project name (2–80 chars and unique), team lead (2–80), unique valid contact email (max 160), team size exactly one of 1, 2 - 4, 4 - 6, 6 - 8, 8+, one or more approved track IDs, a MAINNET NEAR prize address, public repository URL, public X demo post URL, description (20–2,000 chars), and explicit consent to the published contact notice.
- Current approved track IDs include social, open, realworld, defi, thesis, privacy, business, swarms, security, agents, games, nfts, and memecoins. Social Money and Open Innovation appear closest to AjoCircle; select only tracks the actual finished demo genuinely supports. Do not claim a complete Intents or stablecoin contribution flow merely because an estimate-only preview exists.
- The guide says one submission per team, no editing after submission, and a UUID `requestId` that must be reused for retries. Omit the website field because a non-empty value is treated as a spam trap. Project name and email must be unique. Do not send a submission until the human reviews the complete payload and explicitly confirms it.
- The human must publish the public X demo post. The post must say the project was built at NEAR HACKATHON and include video/screenshots. Do not post on the human’s behalf. Record the public post URL only after it exists.
- Eligibility/wording risk: substantial AjoCircle implementation predates the official build window. Confirm the organizers’ interpretation of “build the project during the hackathon,” make and identify substantive work during the official period, and avoid implying pre-event work was performed during the event.
- Current release blockers: GitHub remote still points at the earlier commit; the worktree has extensive uncommitted code; no license has been selected; the X demo post is not published; no official submission is filed. This pass did not stage, commit, push, post, or submit anything.

## Final release verification — 28 October 2026, 08:55 WAT

- Full JavaScript settlement-adapter suite: **384 passed, 0 failed**. This includes the new live-preview safety/runner tests, provider correlation-ID diagnostic test, and bounded NEAR testnet RPC retry tests.
- Rust contract suite: **65 passed, 0 failed**. Existing compiler warnings remain for unused reputation helpers and deprecated NEAR SDK test helpers; no failures.
- Rust settlement-adapter suite: **7 passed, 0 failed**.
- Frontend clean-install build: copied the frontend into `%LOCALAPPDATA%\AjoCircle\clean-web-build-20261028-085649`, removed the inherited `npm_config_allow_scripts` override only in that shell, then `npm ci` and `npm run build` passed. It reported 0 npm vulnerabilities. The running app’s `web/node_modules` was not modified by this clean install.
- `git diff --check`, and `node --check` for the isolated live-preview utility passed. Git prints only existing LF/CRLF conversion warnings.
- Added `.github/workflows/ci.yml` to run Node tests, both Rust suites, and the frontend build in GitHub Actions. The workflow is authored locally but has not been run by GitHub because changes have not been pushed.
- Current finalized read-only chain check at `2026-10-28T07:52:43.126Z`: `ajo-demo-oct24.testnet`, approved code hash `d8026ad1de87e1122ed1fe36578f2fe9be1324f1ed4ef4bc576f8b4b1ee70cdf`, ProtectedPublic, round 0, 0 contributions, no payout pending/completed, not completed, and four deadlines matching local round rows exactly. Persisted binding says `quoteReady=true` and `parityMismatches=[]`; the browser still requires a fresh verification under its 60-second window before preview. No DB write or transaction was needed for this inspection.
- Public RPC health check: `rpc.testnet.fastnear.com` returned chain ID `testnet` and a recent finalized/sync block; `rpc.testnet.near.org` timed out from this machine in that check. Verifier now retries one transient read-only RPC transport failure, then fails closed if the retry also fails.
- Repository hygiene: internal `HANDOFF_*.md`, local recovery snapshots, one-off diagnostic output and `.before-*` backups are now ignored by Git, but preserved on disk. This reduced visible untracked changes; the remaining source and test files still need per-file release review.
- Still blocked for publication/submission: no license selected, the current GitHub remote still points to the earlier commit, a substantial working tree remains uncommitted/untracked, no final public demo video/post exists, and the exact submission fields (especially email and mainnet prize address) need the human’s input. Do not stage, commit, push, post, or submit without explicit human approval.
