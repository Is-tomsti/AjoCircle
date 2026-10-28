# AjoCircle — Judge Quickstart

AjoCircle is a NEAR smart-contract prototype for rotating Ajo/Esusu savings circles. It encodes fixed membership, contribution amounts, payout order, treasurer-gated payouts, and guarded protection-reserve logic. It is an unaudited testnet prototype, not a product for real funds.

## Reproduce the checks

Run from a Windows PowerShell terminal in the repository root. These commands run tests/builds only; they do not deploy or submit transactions.

```powershell
node --test settlement-adapter\*.test.mjs
cargo test --manifest-path contract\Cargo.toml
cargo test --manifest-path settlement-adapter\Cargo.toml
Push-Location web
npm ci
npm run build
Pop-Location
git diff --check
```

Expected result: all JavaScript/Node tests pass, both Rust test suites pass, and Vite produces a production bundle under `web/dist/`.

## See the testnet payout evidence

The project has recorded successful testnet payout/distribution evidence. These are historical experiments on separate testnet contracts/circles, not the current `ajo-demo-oct24.testnet` circle and not proof of production readiness.

- [Round 2 payout transaction — 3 NEAR to `ajotest3.testnet`](https://explorer.testnet.near.org/transactions/HSCMVxa7ZcSSYsGaoA9rAcxWCSMD23uHVqbRycoctHT3). See [TESTNET_PAYOUT_EVIDENCE_2026-10-25.md](TESTNET_PAYOUT_EVIDENCE_2026-10-25.md) for the recorded completion/finality context.
- [Public distribution start](https://explorer.testnet.near.org/transactions/qAoza8KxUHy2uemQvJkNqvrfYdKHnW6nLfnzVqPcP7H), [continue distribution](https://explorer.testnet.near.org/transactions/4EkABcihByqDnigFu5z9DTsWscimE3CZC2ac342yqmkh), and [final continuation](https://explorer.testnet.near.org/transactions/C8K8WLYDFVbMZicCZESnnnzDzxiSuCRkDTmb5WpoRk9C). See [TESTNET_PUBLIC_DISTRIBUTION_EVIDENCE_2026-10-26.md](TESTNET_PUBLIC_DISTRIBUTION_EVIDENCE_2026-10-26.md); its source is the recorded application status result, not a newly fetched explorer reconciliation.

Do not resubmit those completed plans.

## Try the web prototype

1. In one terminal, follow [web/README.md](web/README.md) to start the combined API with a fresh server-only `AJO_SESSION_SECRET` and NEAR testnet RPC.
2. In another terminal, run `Push-Location web; npm ci; npm run dev; Pop-Location`.
3. Open `http://127.0.0.1:5173/` and connect a wallet that supports NEP-413 message signing on testnet.
4. The UI must authenticate through a fresh server challenge. A quote preview is estimate-only; the currently configured local development provider is an explicitly synthetic offline mock. A real market preview requires a separately prepared mainnet context; it is not linked to this testnet circle.
5. Contract and payout actions, where enabled, are testnet-only and require wallet/server confirmation. Never treat a quote or swap delivery as proof of a contract contribution.

A clean clone does not contain the developer machine's local SQLite memberships/session state. Do not manufacture member, wallet-verification, quote, or contribution records to make the UI appear ready; trusted server-side setup and real wallet verification are required. Automated tests are reproducible from the source; wallet interoperability still requires live testing with compatible testnet wallets.

## What is implemented versus planned

Implemented/tested: Rust contract logic and invariants; protected-public reserve accounting; guarded payout execution/plans; NEP-413 authentication components; trusted membership/context storage; schedule-parity gates; testnet lifecycle/evidence checks; estimate-only quote-preview interfaces and offline tests.

Not complete: an independent security audit; a production deployment; a production AI treasury agent; a full production-ready cross-chain contribution flow; persistent on-chain reputation history and end-user reputation product. The live 1Click integration has been exercised only through isolated `dry: true` previews and must not be described as a completed contribution flow. The contract requires native NEAR contributions, while the quote preview destination is wrapped NEAR.

## Submission notes

The official NEAR HACKATHON site currently lists submissions from **1 November 2026 00:00 UTC** through **14 November 2026 23:59 UTC**. Required links are a public repository and a public X demo post with video/screenshots; the post must say the project was built at NEAR HACKATHON. Re-read the official [HACKATHON.md](https://nearhackathon.com/HACKATHON.md) before submitting. Because substantial AjoCircle work predates the official build window, confirm the organizers' interpretation and ensure any hackathon claim accurately identifies work done during the event; do not imply that earlier work all occurred in the event period.