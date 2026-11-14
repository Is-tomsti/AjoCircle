# AjoCircle Web Application

The AjoCircle web client is the member-facing interface for a USDC-denominated Ajo/Esusu savings-circle prototype on NEAR Testnet. Members' savings and contribution amounts are denominated in **USDC**. NEAR is the underlying execution network and gas asset, not the member contribution currency.

## Authentication

AjoCircle supports two identity routes, subject to the capabilities enabled in the current Testnet build:

- **Google/email authentication:** NEAR FastAuth Testnet provides an embedded Testnet identity and key-derivation flow.
- **Existing NEAR wallet:** members may connect a supported NEAR wallet and use the wallet-specific actions made available by the application.

A user's email identity and an existing wallet identity must not be silently merged. Sign-in does not create, activate or fund an account, join a circle, pay an entry fee or submit a transaction. Sensitive actions require explicit user authorization and server-side validation.

See [Embedded Auth Setup](EMBEDDED_AUTH_SETUP.md) for the Testnet identity configuration and limitations.

## Member fees and gas

- Circle entry fee: **0.25 USDC once per member per circle**.
- Eligible distribution fee: **0.5% (50 bps)**, accrued only after the relevant USDC transfer succeeds.
- The intended member experience is platform-sponsored NEAR gas for eligible actions. The member authorizes the action; AjoCircle's controlled relay pays the NEAR network gas.

**Release warning:** the backend relay and frontend release gates remained disabled at the latest recorded acceptance checkpoint. The real-wallet end-to-end journey proving zero member NEAR gas had not yet passed. Do not present sponsorship as activated until the release gates are approved and fresh Testnet evidence is recorded.

## Local development

Requirements: Node.js 24 and npm.

From PowerShell:

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

The API must be started separately using the server-side configuration described in the root README and the settlement-adapter documentation. A clean clone does not contain the developer's local SQLite memberships, sessions, or trusted provisioning data. Do not seed fake member or payment records to make the app appear ready.

## Browser configuration and secrets

Public browser settings may be supplied through `VITE_*` environment variables, for example the API base URL and public FastAuth client configuration. Every `VITE_*` value can be included in the browser bundle.

Never place any of the following in a `VITE_*` variable or in source control:
- Session-signing secrets or JWT private keys.
- NEAR relayer/private keys or seed phrases.
- Provider API tokens.
- Database paths containing sensitive data or database files.
- Any account recovery material.

Keep Testnet RPC, API session secrets, provider credentials, relayer settings and database paths on the server.

## Testnet and safety boundary

- NEAR Testnet only.
- No real funds or Mainnet actions.
- Authentication is not evidence of payment.
- A prepared quote/delegated action is not a settled contribution.
- A USDC transfer is recognized only after the authoritative contract and finalized evidence confirm it.
- The contract/application are experimental and have not received an independent security audit.
