# AjoCircle application identity and trusted-context integration contract

## Status

This is an integration boundary for the current prototype, not an authentication provider or database implementation. No production authentication, membership database, or HTTP server is created by this module. Do not mount member endpoints until real implementations have been supplied and reviewed.

## Adapter

Import `createApplicationContextResolvers` from `application-context-adapter.mjs`. It returns the two callbacks required by `createMemberQuoteHandler`:

- `resolveMemberIdentity({ principal, circleId })`
- `resolveTrustedContext({ circleId, memberId, round })`

Construction requires both an authoritative repository and a `getPrincipalId(principal)` callback. The principal must come from the real authentication middleware after session/token verification. The adapter deliberately does not assume that every provider uses a `sub`, `id`, or `userId` claim.

## Required repository contract

### `findMembershipForPrincipal({ principalId, circleId })`

Query authoritative application records using the verified principal identifier and requested circle. Return either `null` or an object with:

- `circleId`: the exact requested circle ID
- `memberId`: the application's canonical member ID
- `status`: exactly `ACTIVE` for an eligible membership

The adapter returns no member ID for missing, inactive, mismatched, or malformed membership records. It never uses a member ID from the request body.

### `getMemberQuoteContext({ circleId, memberId, round })`

Load a trusted, internally consistent context snapshot for those exact identifiers. Return an object containing:

- Identity: `circleId`, `memberId`, `round` (must exactly match the lookup)
- States: `circleStatus`, `memberStatus`, `roundStatus`; quote creation requires `ACTIVE`, `ACTIVE`, and `OPEN`
- Destination: `memberNearAccount`
- Contribution: `requiredContributionAmount`, as a positive integer string in the contract's native-NEAR base units
- Origin assets: `allowedOriginAssets`, an explicit allowlist of exact provider asset IDs
- Refunds: `refundAddresses`, mapping each allowed asset ID to the member's registered source-chain refund address
- Limits: `maxInputAmounts`, mapping each allowed asset ID to a positive integer string in that asset's base units
- Timing: `roundDeadlineMs`, a positive safe-integer Unix timestamp in milliseconds from authoritative round state. Quote requests are rejected at or after this deadline, and the 1Click quote expiry is capped at the earlier of 15 minutes or the round deadline.

The adapter returns only these documented fields and makes defensive copies of arrays/maps. Repository errors, missing context, and identifier mismatches fail closed. The quote service performs the final status, asset, wallet, amount, quote-output, and persistence checks.

## Handler wiring (server-side only)

```js
import { createApplicationContextResolvers } from './application-context-adapter.mjs';
import { createMemberQuoteHandler } from './member-quote-handler.mjs';

const resolvers = createApplicationContextResolvers({
  // Must query the application's authoritative membership and round records.
  repository: applicationMembershipRepository,
  // Must extract a stable ID from a principal produced by verified auth middleware.
  getPrincipalId: principal => verifiedAuthProviderAdapter.getStableUserId(principal),
});

const memberQuoteHandler = createMemberQuoteHandler({
  store: settlementStore,
  quoteClient: oneClickQuoteClient,
  authenticateRequest: request => verifiedSessionMiddleware.authenticate(request),
  ...resolvers,
});
```

The names above are illustrative dependency names, not implemented imports or working production services. Do not copy this example into a running server until those real dependencies exist. Keep the store, 1Click credentials, repository, and handler on the server; never expose them to browser code.

## Required production safeguards still outstanding

- Real session/token verification, expiry/revocation, and CSRF protection where cookie authentication is used.
- Database-backed membership and round queries with clear transaction/snapshot consistency.
- Raw request body size limits at the HTTP framework, per-user/IP rate limiting, safe operational logging, and monitoring.
- Integration tests against the chosen auth middleware and real database adapter.
- Independent security review and an end-to-end test environment.

A generated quote or verified wrapped-NEAR delivery remains distinct from a native-NEAR contribution recorded by the current contract. This adapter does not submit transactions, credit contributions, unwrap assets, or authorize payouts.
