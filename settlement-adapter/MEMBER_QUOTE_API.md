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

All three callbacks are mandatory at handler construction. The handler authenticates before parsing a request body, derives the member identity server-side, gets the refund address from trusted context, then delegates validation and durable intent creation to `createTrustedMemberQuote`. Do not mount the endpoint until these callbacks are connected to real production-grade auth and authoritative storage.

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
