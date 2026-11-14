# AjoCircle Settlement Adapter

This directory contains the server-side application, identity, settlement-evidence, and guarded transaction components used by the AjoCircle USDC Testnet prototype.

AjoCircle's member savings asset is **USDC**. The project does not use native NEAR as the member contribution or payout currency. NEAR remains the execution network and is used to pay the gas required for eligible contract and relay actions.

## Product accounting

- One-time entry fee: 0.25 USDC per member per circle.
- Eligible distribution fee: 50 basis points (0.5%) on eligible gross USDC distributions.
- The distribution fee is accrued only after the relevant USDC transfer succeeds.
- Member principal, entry fees, penalties, protection liabilities and platform fees remain distinct accounting categories.

## Identity and action authorization

The application supports NEAR FastAuth Testnet identity components and supported existing NEAR-wallet flows. Every wallet action must be bound to the authenticated session, wallet identity, circle and exact operation. Email and wallet identities are not silently merged. A sign-in or quote preview is not a payment, membership record or contribution.

## Sponsored gas

The intended member experience is that the member explicitly authorizes an eligible action while the AjoCircle relayer pays the NEAR network gas. The NEP-366 path must validate the signed delegated action, member identity, operation scope, nonce/lifetime and sponsor spending limits before submission.

**Activation boundary:** at the latest recorded release checkpoint, the backend relay and frontend release flag remained disabled pending key-custody, reserve, spend-cap and real-wallet acceptance checks. Do not report sponsored gas as live until those checks have passed and fresh Testnet evidence is available.

## Development checks

From the repository root:

```powershell
node --test settlement-adapter\*.test.mjs
```

For the active USDC contract, run the commands in [the root README](../README.md) against `central-contract-usdc-segment3/`.

Tests use mocks and local fixtures unless explicitly identified as a live read-only Testnet check. Do not treat a quote, prepared delegated action, simulated receipt or local state as proof of a finalized USDC contribution.

## Operational safety

- Testnet only. No Mainnet transactions or real funds.
- Keep session secrets, provider tokens, NEAR relayer keys, wallet seeds and database files out of Git and browser bundles.
- Never expose a membership-provisioning or privileged relay method directly to an unauthenticated browser.
- Do not activate payout, refund, withdrawal or relay paths without the separate approval and security gates.
- The prototype has not received an independent security audit.
