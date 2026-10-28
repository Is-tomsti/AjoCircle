# Authenticated member quote endpoint

`member-quote-handler.mjs` exports `createMemberQuoteHandler(...)` for `POST /api/member/quote`. It is a framework-free Node.js request handler, not a running server.

## Request

Send JSON with only these fields:

- `circleId`: circle identifier
- `round`: non-negative integer round number
- `originAsset`: exact server-supported asset identifier
- `amount`: positive integer in the origin asset's base units, as a string
- `slippageTolerance` (optional): basis points, validated by the quote-request builder
- `depositMode` (optional): `SIMPLE` or `MEMO`

The client must not send `memberId` or `refundTo`; requests containing unsupported fields are rejected. The member's identity and refund wallet are resolved on the server.

## Required integration callbacks

- `authenticateRequest(request)` must validate the real application session/token and return a trusted principal, or a falsy value. Never trust an identity copied from request JSON or an unverified header.
- `resolveMemberIdentity({ principal, circleId })` must use that authenticated principal and authoritative application records to return the member ID for the specified circle, or a falsy value when the principal is not a member.
- `resolveTrustedContext({ circleId, memberId, round })` must load authoritative circle, membership, round, NEAR account, registered source-chain refund wallet(s), supported origin assets, contribution amount, and per-asset input limits. It must return the matching IDs and expected statuses documented in `quote-service.mjs`.

All three callbacks are mandatory at handler construction. The handler authenticates before parsing a request body, derives the member identity server-side, gets the refund address from trusted context, then delegates validation and durable intent creation to `createTrustedMemberQuote`. The trusted context must include the authoritative `roundDeadlineMs`; requests at or after that deadline are rejected, and quote expiry cannot extend beyond it. Do not mount the endpoint until these callbacks are connected to real production-grade auth and authoritative storage.

## Responses and limits

- `201`: quote and persisted pending-intent details
- `400`: malformed/unsupported request or missing registered refund wallet
- `401`: no authenticated principal
- `403`: no trusted membership/context
- `404`: route not found
- `405`: wrong method
- `413`: body exceeds 16 KiB
- `422`: trusted quote validation or quote provider request rejected

Responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Provider and internal errors are not returned to the client. Do not log credentials or sensitive session data.

## Current product boundary

This endpoint is an integration component only. No real authentication provider, application database, running HTTP server, or live 1Click request is configured by this module. Unit tests use mocked identity/context callbacks and mocked quote responses. A successful quote targets `nep141:wrap.near`; that wrapped-NEAR delivery still does not satisfy the current contract's native-NEAR `contribute()` call. Do not credit a circle or authorize a payout from quote creation or swap delivery alone.


## Estimate-only preview endpoint

The local app server also exposes authenticated `POST /api/member/quote/preview` through the same member/session and trusted-context checks. It uses `dry: true`, can run without `ONECLICK_API_TOKEN`, returns estimate fields only, and does not call `createPendingIntent` or persist a settlement intent. The response explicitly sets `status: "PREVIEW_ONLY"` and `contributionReady: false`; any provider-supplied deposit address, memo, or signature is stripped.

This is an estimate, not an instruction to send funds. The preview destination remains `nep141:wrap.near`, while the current AjoCircle contract requires native NEAR for `contribute()`. Never treat the preview or a wrapped-NEAR swap as a contribution.

## NEAR refund-wallet verification

The local testnet app mounts authenticated `POST /api/member/refund-wallet/verify`.

Request JSON accepts exactly these fields:

- `circleId`: active circle identifier
- `assetId`: active circle-approved NEP-141 asset identifier beginning with `nep141:`
- `address`: the member's already-registered refund address

The handler authenticates the session first and derives the principal from the authenticated session subject. It rejects caller-supplied identity fields and unsupported request fields. The store marks the registered wallet `VERIFIED` only when the authenticated principal maps to an active member whose NEAR account exactly matches the registered address, and the circle, membership, asset, and wallet are all active.

Responses: `200` verification recorded; `400` malformed/unsupported request; `401` unauthenticated; `403` verification rejected; `404` unknown route; `405` wrong method; `413` body exceeds 16 KiB. Responses are `no-store`; internal store errors are not exposed.

**Important trust boundary:** this flow is a server-side match between an authenticated NEAR account and an existing registered NEAR address. It is not a general cryptographic proof of arbitrary wallet ownership and must not be used for EVM, Solana, Tron, or other address families. It does not register or replace a wallet. It does not submit a transaction, prove a contribution, or authorize payout. Quote creation still depends on all independent trusted-context, contract-binding, schedule-parity, round-lifecycle, and asset checks. The local tests do not establish a live end-to-end authenticated browser session.

## NEAR refund-wallet registration

Authenticated `POST /api/member/refund-wallet/register` registers the authenticated member's own stored NEAR account for an active circle-approved `nep141:` asset. The request accepts only `circleId` and `assetId`; the server derives the principal, member, and NEAR account from trusted records.

Registration is separate from verification and starts as `UNVERIFIED`. Repeating registration for the same active address is idempotent. If a registration already exists but is inactive or differs from the authenticated NEAR account, the request is rejected without replacing or reactivating the existing record. Conflicting records require trusted manual review. This flow does not prove arbitrary wallet ownership, accept caller-supplied addresses, submit transactions, or enable contribution/payout by itself.
