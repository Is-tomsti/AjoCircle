# AjoCircle

AjoCircle is a USDC-denominated Ajo/Esusu savings-circle application built on NEAR. Members' savings, contributions, entry fees and distributions are accounted for in **USDC**. NEAR is the underlying Testnet execution network and gas asset; it is not the currency members contribute to a circle.

AjoCircle is designed to make community savings easier to access through two identity routes: Google/email authentication using NEAR FastAuth, or connection of an existing NEAR wallet. Members must explicitly authorize wallet actions. Signing in is not itself a payment, membership confirmation or transaction.

## Product flow

1. **Sign in.** A user authenticates with Google/email through the embedded NEAR FastAuth flow, or connects an existing NEAR wallet.
2. **Discover and review.** The user browses available circles and reviews the circle's contribution schedule, participation rules, deadlines and fees before joining.
3. **Join and pay the entry fee.** Joining and paying the entry fee are separate steps. The one-time entry fee is **0.25 USDC per member, per circle**. A member is not treated as fee-paid or eligible merely because they pressed Join; the USDC payment must be verified.
4. **Contribute in USDC.** Member contribution amounts and circle accounting are denominated in USDC, not native NEAR.
5. **Distribute under the circle rules.** Eligible USDC distributions follow the on-chain circle rules and are reconciled against successful token-transfer outcomes.

## Fees and gas

- **Entry fee:** 0.25 USDC once per member per circle.
- **Distribution fee:** 0.5% (50 basis points) on eligible successful gross USDC distributions. The fee is accrued only after the relevant USDC transfer succeeds; a failed transfer does not accrue the fee.
- **Member transaction gas:** AjoCircle's intended experience is that members do not need to hold NEAR or pay NEAR gas for eligible sponsored actions. The member authorizes the action; AjoCircle's sponsor/relay submits the delegated transaction and pays the eligible network gas from its NEAR balance.
- **Relay status:** The Segment 3 USDC contract is deployed on NEAR Testnet, but the latest recorded release checks kept the backend relay and frontend release gates disabled. The live zero-member-NEAR journey has not yet passed end-to-end wallet acceptance. Therefore sponsored gas is the intended design, not a claim that the public release currently offers an activated gasless transaction service.
- **External withdrawals:** A withdrawal fee is not fixed here. Any future fee must be based on the actual relay/provider quote plus a separately disclosed service component.

## Network and Testnet deployment

AjoCircle's current USDC contract is deployed on **NEAR Testnet**:

| Item | Value |
|---|---|
| Network | NEAR Testnet |
| Contract | `ajocirclevault1.testnet` |
| Platform sponsor / contract owner | `ajocirclepot1.testnet` |
| USDC token contract | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` |
| Token | USDC |
| Decimals | 6 |
| Contract schema | 1 |
| Entry fee | 250,000 base units (0.25 USDC) |
| Distribution fee | 50 bps (0.5%) |

The Segment 3 code-only Testnet upgrade was finalized on 12 November 2026 and the deployed Wasm bytes were independently re-read and hash-checked. [View the deployment transaction](https://explorer.testnet.near.org/transactions/7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B).

This is a **Testnet prototype**, not a production savings service. The deployment record confirms a code upgrade and configuration verification; it does not prove a live member contribution, entry-fee payment, payout, refund or withdrawal. At the last recorded read-only contract check, no active circle summaries or USDC liabilities were found. Do not treat a local UI state, a quote, a planned action or a test fixture as proof of an on-chain payment.

## Authentication and wallet safety

- NEAR FastAuth Testnet supports Google/email identity sign-in and an embedded Testnet account/key derivation path.
- Users may also use an existing NEAR wallet where the relevant wallet flow is supported.
- Email identity and an existing wallet identity must not be silently merged. Existing membership records remain bound to their verified identity and wallet evidence.
- Each transaction or delegated action must be scoped to the active session, wallet, circle and exact operation. A stale wallet session must not authorize an action for a different account.
- Authentication does not automatically create, activate or fund an on-chain account.
- The Testnet FastAuth client is for development only. Do not use it for Mainnet or production authentication.

## Implementation status and release boundaries

**Implemented and locally tested**
- USDC-specific contract configuration and accounting for the 0.25 USDC entry fee and 50-basis-point distribution fee.
- USDC transfer-attempt records with nonce/fingerprint binding, recipient storage-registration checks, callback-based settlement accounting and bounded retry handling.
- Testnet contract deployment and byte-level verification.
- FastAuth Google/email identity components, wallet identity handling, session isolation and typed failure states.
- Segment 3 relay preparation, delegated-action validation and reconciliation components with regression tests.

**Still gated or not yet demonstrated end to end**
- Public activation of the sponsored relay and the frontend release flag.
- Real-wallet acceptance proving that an eligible member can authorize an action while AjoCircle's relayer pays the NEAR gas.
- Full live join-to-entry-fee-to-contribution and payout journeys against the deployed Testnet contract.
- Production payout, distribution, refund and withdrawal activation.
- Independent smart-contract/security audit, production key custody, operational monitoring and production deployment.
- A production-grade AI treasury agent with transaction authority. Any treasury assistance must remain advisory; it must not silently sign or submit transfers.

The release must remain Testnet-only. No Mainnet deployment, real funds, wallet signing, account funding, USDC transfer, payout activation or relayer activation is authorized by this README.

## Development and verification

The active USDC contract working copy is in `central-contract-usdc-segment3/`. The Vite frontend is in `web/`; the API, wallet/authentication services, sponsored relay and reconciliation modules are in `settlement-adapter/`.

Run the USDC contract checks from the contract directory:

```powershell
Set-Location .\central-contract-usdc-segment3
cargo fmt --all -- --check
cargo test --offline --lib -- --skip central_multi_circle_storage_scale_benchmark
cargo clippy --offline --all-targets -- -D warnings
```

Run the frontend production build from the repository root:

```powershell
Push-Location .\web
npm ci
npm run build
Pop-Location
```

The recorded Segment 3 Rust validation after the 12 November code upgrade was 88 passed, 0 failed and 2 ignored. The ignored cases are manual/scale checks. Recorded JavaScript relay/wallet regression tests passed 34/34, and the combined Segment 3 app-server/relay suite passed 66/66 at its recorded checkpoint. These are local automated-test results; they do not replace a live-wallet acceptance run, on-chain transaction evidence or an independent audit. The full frontend test sweep had outstanding unrelated failures at the last recorded UI checkpoint, so this README does not claim that every frontend test is green.

Keep server-only secrets (session-signing keys, relayer keys, provider credentials and database paths) out of the browser bundle, source control and public issue reports. Never put secrets in `VITE_*` variables. Do not run deployment, signing, funding, relay or funds-moving commands as part of ordinary development checks.

## Security and transparency

A private circle means admission is controlled by invitations or membership rules; it does not mean on-chain data is confidential. Public-chain account IDs and contract state can be independently queried. Do not promise confidentiality for wallet identities, membership, contribution history or other data exposed by public contract views.

The contract and application are experimental Testnet software and have not received an independent security audit. Do not use real funds.

## License

The project code is licensed under the [MIT License](LICENSE). Third-party dependencies remain subject to their own licenses.