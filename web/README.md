# AjoCircle testnet wallet UI

A Vite frontend for NEP-413 wallet authentication, member workflows, read-only contract checks, estimate-only quote previews, and guarded NEAR testnet actions. Some controls can request a user-authorized testnet transaction through the connected wallet or the authenticated local payout workflow; none is meant for mainnet or real funds, and wallet confirmation plus server-side checks are required.

## Connector choice

Uses `@hot-labs/near-connect` (HOT Connect / NEAR Connect) with the manifest feature filter `{ signMessage: true, testnet: true }`. The current NEAR Wallet Selector repository recommends evaluating HOT Connect as the preferred connector while Wallet Selector remains supported during a transition. The feature filter intentionally hides wallets that do not advertise NEP-413 message signing on testnet. Wallet capabilities are metadata-driven and can change, so the real-wallet test report must record the actual wallet versions and results.

## Setup

```powershell
cd C:\Users\Tomsti\AjoCircle\web
Copy-Item .env.example .env
npm install
npm run dev
```

`VITE_AJO_API_BASE_URL` is a public API URL only. It must point to a real configured AjoCircle testnet API. If blank, the page calls the same origin. **Do not put server secrets in any `VITE_` variable or in this folder.** Keep `NEAR_RPC_URL`, `AJO_SESSION_SECRET`, the auth SQLite path, issuer/audience configuration, and trusted repository configuration on the server.

`settlement-adapter/ajo-testnet-app-server.mjs` now composes the NEP-413 auth routes, server-side bearer verification, `ApplicationStore` membership/context resolvers, `SettlementStore` pending-intent persistence, and the real `OneClickQuoteClient` when `ONECLICK_API_TOKEN` is set. It binds only to `127.0.0.1` and pins RPC to NEAR testnet. Without the 1Click credential, quote requests return `503 TESTNET_QUOTE_BACKEND_NOT_CONFIGURED` only after authentication, membership/context, and registered-refund-wallet checks. The SQLite application database starts empty unless trusted server-side provisioning has populated it; no public membership-provisioning route exists. Never substitute mocked endpoints for real-wallet acceptance testing.

## Login flow

1. `POST /api/auth/near/challenge` with `{}`.
2. Preserve the server's exact `message`, `recipient`, `nonce`, and `expiresAt`.
3. Decode the server's base64 nonce into exactly 32 bytes and call the connector with the challenge's exact message/recipient/nonce.
4. On `wallet:signInAndSignMessage`, post the returned account ID, public key, signature, and the unchanged challenge fields to `POST /api/auth/near/verify`.
5. Save the short-lived bearer token in `sessionStorage` for the current tab only.
6. Send `Authorization: Bearer <token>` on `POST /api/member/quote`.

The UI distinguishes a user-cancelled signature, an expired challenge, a wallet that returns no usable signature, and API/server failures. A generic server 401 cannot distinguish every server-side rejection reason; when the challenge is not locally expired, the page reports that verification failed and asks the user to retry with a fresh challenge.

## Security notes

- Testnet connector features are filtered in the browser; server `NEAR_RPC_URL` must independently be configured to NEAR testnet. The server must fail closed if RPC errors or times out.
- `VITE_AJO_API_BASE_URL` is not a secret. No RPC credential or session-signing secret belongs in the browser bundle.
- The bearer token is kept in `sessionStorage`, not a URL or `localStorage`, and is cleared on sign-out/expiry. Production should prefer an HttpOnly, Secure, SameSite cookie when the app's server/session design supports it.
- No funds are moved by signing a NEP-413 message. A quote is not a contribution or payout.
- The combined local server limits challenge creation to 10 requests per remote IP per 60 seconds and cleans expired challenge rows every 60 seconds. The limiter is in-memory and per-process, so it is not a distributed or production-grade abuse control; add trusted-proxy handling, shared rate limiting, monitoring, TLS, and deployment-specific protections before any public exposure.

## Verification status

`npm run build` verifies frontend bundling only. It does not prove wallet interoperability, testnet RPC behavior, or server composition. Authentication must not be marked complete until at least two different testnet wallets complete the challenge-sign-verify flow against the real configured server and NEAR testnet RPC, with their wallet versions, signature response shape, and message-format behavior recorded.

## Local real-RPC wallet interoperability test

The repository includes `settlement-adapter/ajo-testnet-app-server.mjs`, a loopback-only combined auth/membership/quote server for testing against the real public NEAR testnet RPC. It uses durable SQLite files for auth challenges, application membership/context, and pending settlement intents. It is not a production server. The older `near-wallet-auth-testnet-server.mjs` remains auth-only; use the combined server below for membership/quote integration.

In a separate PowerShell window, create a server-only session secret in that shell (this prints nothing and writes no secret file), then start the server:

```powershell
$env:NEAR_RPC_URL = 'https://rpc.testnet.fastnear.com'
$env:AJO_TESTNET_WEB_ORIGIN = 'http://127.0.0.1:5173'
$env:AJO_AUTH_RECIPIENT = 'http://127.0.0.1:5173'
$env:AJO_SESSION_SECRET = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
# Optional: set this only when you have a valid 1Click API credential.
# $env:ONECLICK_API_TOKEN = 'set-in-this-server-shell-only'
node 'C:\Users\Tomsti\AjoCircle\settlement-adapter\ajo-testnet-app-server.mjs'
```

In another PowerShell window, start the frontend from `web/` with `npm run dev`. If the previous auth-only server is already using port 8787, stop that process before starting this combined server. The server binds only to `127.0.0.1:8787`, pins its RPC URL to `https://rpc.testnet.fastnear.com`, limits challenge creation to 10 requests per IP per minute, and cleans expired challenge rows every 60 seconds. The local suspension callback is a test-only policy. Default SQLite paths are under `%LOCALAPPDATA%\\AjoCircle` (or the home directory if `LOCALAPPDATA` is absent); override them with `AJO_AUTH_DB_PATH`, `AJO_APPLICATION_DB_PATH`, and `AJO_SETTLEMENT_DB_PATH`. Keep the three files separate.

The application database does not auto-create circles or memberships. Until a trusted server-side setup operation populates the authoritative circle, member, active membership, open round, approved asset, and registered refund-address rows, an authenticated wallet will receive `403 MEMBERSHIP_REQUIRED`. Do not create fake membership data to make the UI appear to work. If `ONECLICK_API_TOKEN` is not set in the server process, eligible members receive `503 TESTNET_QUOTE_BACKEND_NOT_CONFIGURED`; with it configured, quote requests can create a pending intent but still do not submit a blockchain transaction or credit a contribution. Never put this credential in a `VITE_` variable or commit it.

For each wallet, record wallet name/version, testnet account ID, whether `signInAndSignMessage` was offered, whether signing completed, the shape of the returned `signedMessage`, and the verify response. Do not copy session tokens or signatures into bug reports. Do not expose this server publicly or use it for real funds.
