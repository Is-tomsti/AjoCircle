# AjoCircle Segment 3 — USDC Testnet Contract

This is the active Segment 3 USDC contract source for AjoCircle. AjoCircle's member-facing savings currency is **USDC**. Native NEAR is not accepted as a member contribution or payout asset; NEAR is used by the underlying network for contract execution and eligible sponsored gas.

## Testnet configuration

| Setting | Value |
|---|---|
| Network | NEAR Testnet |
| Contract account | `ajocirclevault1.testnet` |
| Platform sponsor / contract owner | `ajocirclepot1.testnet` |
| USDC token account | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` |
| Token decimals | 6 |
| One-time entry fee | 0.25 USDC per member per circle |
| Eligible distribution fee | 50 bps (0.5%) |

The one-time entry fee is 250,000 USDC base units. The 50-basis-point platform distribution fee is accrued only after an eligible USDC transfer succeeds. Entry fees, member principal, penalties, protection liabilities and platform fees remain separate accounting categories.

## Transfer safety

The shared USDC payout path persists an immutable attempt before dispatch, binds its fields to a monotonic nonce and SHA-256 fingerprint, checks the recipient's NEP-145 storage registration, and applies accounting only from the private transfer callback. A definite transfer failure preserves the original liabilities and can be retried under a fresh nonce. An absent callback is not assumed to mean success or failure.

The contract's USDC transfer logic does not, by itself, make the member journey gasless. A separate NEP-366 sponsor/relayer is responsible for submitting eligible member-authorized delegated actions and paying the NEAR gas. The relayer and frontend release gates were still disabled at the latest recorded acceptance checkpoint. Do not describe sponsored gas as live until the real-wallet, reserve, key-custody and end-to-end acceptance gates pass.

## Deployment record

The Segment 3 release was deployed to the already initialized `ajocirclevault1.testnet` account as a code-only upgrade on 12 November 2026. The finalized deployment transaction is [7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B](https://explorer.testnet.near.org/transactions/7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B).

The deployed Wasm was read back from finalized Testnet state and matched the release artifact SHA-256:
`463DF1634CC629EF8E670E0A06DDA1033E758D236F4D39779DDC2AE146CFE5A1`.

This code deployment did not create a circle, collect an entry fee or contribution, or activate payouts, refunds, withdrawals or the relayer. Testnet only; no real funds.

## Build and test

Run from this directory:

```powershell
cargo fmt --all -- --check
cargo test --offline --lib -- --skip central_multi_circle_storage_scale_benchmark
cargo clippy --offline --all-targets -- -D warnings
```

The recorded post-deployment validation was 88 passed, 0 failed and 2 ignored. The ignored tests are manual/scale checks. These tests do not replace live-wallet acceptance, finalized transaction evidence for a member journey or an independent security audit.

## Release restrictions

- Keep all activity on NEAR Testnet.
- Do not enable the relayer or payout gates without a separate security, reserve, key-custody and owner-approval review.
- Do not deploy, initialize, sign, fund, transfer USDC, submit a relay action or move funds based on this documentation alone.
- Do not expose signer keys, seed phrases, server credentials or local database files.