# 1Click credential and safe-integration setup

## Current status

AjoCircle's local app server is deliberately testnet-oriented and the active NEAR contract is deployed on NEAR testnet. The 1Click API endpoint (https://1click.chaindefuser.com) is a live service; it is not a NEAR testnet simulator. A committed quote (dry: false) can return a real deposit address and must be treated as a live settlement instruction.

**Do not add a 1Click JWT to the current testnet server just to make the quote test pass.** The current member quote implementation commits a quote and persists a pending intent. A successful 1Click quote delivers nep141:wrap.near, which does not satisfy the contract's current native-NEAR contribution requirement. Quote creation is not a contribution, and swap delivery is not proof that the contract received a contribution.

## Requesting credentials

The official one-click-sdk-typescript repository documents JWT authentication and links to the 1Click JWT request form:

- SDK repository: https://github.com/defuse-protocol/one-click-sdk-typescript
- JWT request form (linked by the SDK README): https://docs.google.com/forms/d/e/1FAIpQLSdrSrqSkKOMb_a8XhwF0f7N5xZ0Y5CYgyzxiAuoC2g4a2N68g/viewform
- API docs: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api

A JWT is optional for making some 1Click requests, but authenticated access affects the applicable fee schedule and may be required for particular API operations or limits. Obtain credentials only through the official process and confirm current terms with the provider.

## Secret handling requirements

When a separate, explicitly approved live-quote environment is ready:

1. Store the JWT only in the server environment as ONECLICK_API_TOKEN; never put it in frontend code, browser storage, source control, screenshots, or chat.
2. Do not print the token to logs or diagnostics. Check only whether it is configured.
3. Keep quote creation behind the authenticated member endpoint. The server must resolve member identity, NEAR recipient, refund address, supported asset, contribution amount, and deadline from trusted storage.
4. Use dry: true for a preview-only integration test. Do not create a committed quote (dry: false) merely to test connectivity.
5. Use a dedicated environment and explicit operator approval before any live quote can produce deposit instructions.
6. Keep 1Click quote/settlement status separate from contract contribution state. Only a verified native-NEAR contribute() transaction and on-chain state can count as a contribution under the current contract.

## Current safe test plan

- Run the offline OneClickQuoteClient tests with mocked HTTP responses.
- Run the app-server integration test with no token and verify authenticated quote requests fail closed with HTTP 503 and no provider call or persisted quote intent.
- Keep the active testnet app without a 1Click JWT until a preview-only path or a separately approved live environment is implemented.
- Do not submit deposits, contract contributions, reserve funding, or payouts as part of quote integration tests.


## Implemented preview route

The local testnet app exposes `POST /api/member/quote/preview` for authenticated members. This route sends `dry: true`, does not require `ONECLICK_API_TOKEN`, strips any deposit address/memo/signature fields from the response, and never persists a settlement intent. Offline tests use mocked provider responses; they do not call the live 1Click API.

The preview still targets `nep141:wrap.near`. It is useful for displaying an estimate only and does not satisfy the contract's native-NEAR contribution requirement. The committed `POST /api/member/quote` route remains blocked unless the server-side token is configured.


## Live-preview boundary for the current testnet app

The public 1Click API is live infrastructure, not a NEAR testnet simulator. Its token catalog includes mainnet routes/assets; the fact that the app is connected to NEAR testnet does not make a provider quote testnet-only. A request with `dry: true` does not create a deposit address, but it still sends the chosen asset IDs and recipient/refund address to the external provider and can return real market pricing.

The active AjoCircle cycle identities are `*.testnet` accounts. The app now fails closed before contacting 1Click if live preview is explicitly enabled while the request recipient or refund address ends with `.testnet`. Do not remove this guard to make a quote return. A real-market preview requires a separately prepared live context with valid mainnet-compatible recipient and origin-chain refund addresses and informed approval to disclose those addresses to the provider. That is distinct from the testnet circle and does not authorize a committed quote or deposit.

The first 2026-10-28 live probe used the active circle’s `.testnet` recipient/refund accounts and returned HTTP 400. A follow-up `dry: true` probe with a public mainnet NEAR account returned HTTP 201 and a real estimate for this pair, confirming that the route is accepted in a mainnet-compatible context. The current app UI remains on the synthetic offline mock; no JWT was added, no live-preview flag was enabled, and live settlement remains disabled. Provider correlation IDs are now retained in bounded local diagnostics.

## Isolated real-market preview diagnostic

The current public 1Click API was successfully queried on 2026-10-28 with `dry: true` for 1 USDT on NEAR to wrapped NEAR using the public mainnet NEAR account `near` as diagnostic recipient and refund account. The provider returned HTTP 201 with a market estimate and no deposit address, memo, or signature in the parsed preview. A separate probe using the active circle `.testnet` recipient/refund identity returned HTTP 400; this was an address-context mismatch, not evidence that the USDT-to-wNEAR route is unavailable.

For a real estimate for the user own mainnet-compatible addresses, use the isolated diagnostic:

```powershell
$env:AJO_LIVE_PREVIEW_RECIPIENT = '<your mainnet NEAR recipient account>'
$env:AJO_LIVE_PREVIEW_REFUND_TO = '<your mainnet-compatible NEAR refund account>'
$env:AJO_LIVE_PREVIEW_AMOUNT = '1000000'
node .\settlement-adapter\preview-live-1click.mjs
Remove-Item Env:AJO_LIVE_PREVIEW_RECIPIENT,Env:AJO_LIVE_PREVIEW_REFUND_TO,Env:AJO_LIVE_PREVIEW_AMOUNT -ErrorAction SilentlyContinue
```

This utility is isolated from the testnet app session, database, and circle state. It always sends `dry: true`, refuses `.testnet` account IDs before a provider call, prints no recipient/refund values, and cannot commit a quote or return a deposit address. It requires mainnet-compatible addresses supplied locally; do not paste them into chat. The quote remains a market estimate and does not make wrapped NEAR a native-NEAR contribution to the testnet contract.