# AjoCircle — Judge Quickstart

AjoCircle is a USDC-denominated Ajo/Esusu savings-circle prototype built on NEAR Testnet. USDC is the member savings asset. NEAR is used by the network for execution and gas, and the intended member experience is sponsored transactions so eligible members do not need to acquire NEAR for gas.

## Current Testnet contract

- Contract: `ajocirclevault1.testnet`
- Platform sponsor / contract owner: `ajocirclepot1.testnet`
- USDC token: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
- Token decimals: 6
- Entry fee: 0.25 USDC once per member per circle
- Distribution fee: 50 bps (0.5%) on eligible successful gross USDC distributions
- Code-only contract upgrade (12 November 2026): [finalized Testnet transaction](https://explorer.testnet.near.org/transactions/7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B)

The deployed Wasm was independently re-read from finalized Testnet state and matched the release SHA-256 recorded in `central-contract-usdc-segment3/SEGMENT3_TESTNET_DEPLOYMENT_RECORD_2026-11-12.md`.

## Reproduce contract checks

Run from the repository root in PowerShell:

```powershell
cargo fmt --manifest-path central-contract-usdc-segment3\Cargo.toml -- --check
cargo test --locked --manifest-path central-contract-usdc-segment3\Cargo.toml
cargo clippy --locked --manifest-path central-contract-usdc-segment3\Cargo.toml --all-targets -- -D warnings
```

For the frontend:

```powershell
Push-Location web
npm ci
npm run build
Pop-Location
```

For the Node settlement-adapter tests:

```powershell
node --test settlement-adapter\*.test.mjs
```

The recorded post-deployment Segment 3 Rust validation was 88 passed, 0 failed and 2 ignored. The recorded relay/wallet tests were 34/34, and the combined Segment 3 app-server/relay suite was 66/66 at its checkpoint. These are automated local tests, not proof of a live member transaction or an independent audit. The full frontend test sweep had outstanding unrelated failures at the last recorded UI checkpoint; the CI frontend job therefore performs the production build, not a claim that all browser tests pass.

## Authentication and gas sponsorship

New users can sign in through the NEAR FastAuth Testnet Google/email flow and derive an embedded Testnet identity. Existing NEAR wallet connection is supported where the relevant wallet/action path is available. Identity switching is isolated; wallet identities are not automatically merged by email.

The intended sponsored flow is: member explicitly authorizes the action, then the platform relay submits the delegated action and pays eligible NEAR network gas. **The relayer and frontend release gates were disabled at the latest recorded acceptance checkpoint.** A real-wallet end-to-end zero-member-NEAR acceptance journey had not yet passed. Do not describe gas sponsorship as activated in the public demo until that gate is cleared and new evidence is recorded.

## Demo and safety boundary

- Demonstrate only UI states and Testnet evidence that you can reproduce at recording time.
- A code deployment is not evidence of a member contribution, entry-fee payment, payout or refund.
- Do not fabricate circles, memberships, wallet signatures, payment receipts or transaction hashes.
- Testnet only. No real funds, Mainnet transaction, payout activation or relayer activation is authorized by these instructions.
- The contract and application have not received an independent security audit. Do not describe them as production-ready.
