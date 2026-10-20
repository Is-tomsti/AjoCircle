# AjoCircle application metadata store

## What this is

`application-store.mjs` is a persistent SQLite repository that implements the membership and trusted-context repository contract documented in `APPLICATION_CONTEXT_INTEGRATION.md`. It stores server-managed circle metadata, verified auth-provider principal mappings, membership status, rounds, allowed origin assets, maximum input amounts, and registered refund addresses.

It uses Node's built-in `node:sqlite`; no additional package is needed. It is separate from `settlement-store.mjs`, which records pending settlement intents and verified delivery evidence.

## Schema ownership and trust boundary

All `upsert*` and `set*` methods are privileged server-side provisioning operations. They must only be called by trusted application workflows after circle creation, verified membership changes, round updates, asset policy changes, or refund-address verification. Never expose these methods or the store object directly to browser code or an unauthenticated route.

The `principalId` passed to `upsertMember` must be the stable user identifier from the chosen, verified authentication provider. This store does not validate sessions, verify JWTs, issue cookies, or implement login. Until real authentication middleware exists, no member-facing endpoint should be mounted.

## Example: server-side initialization

```js
import { ApplicationStore } from './application-store.mjs';
import { createApplicationContextResolvers } from './application-context-adapter.mjs';

const applicationStore = new ApplicationStore({
  path: process.env.AJOCIRCLE_APPLICATION_DB ?? 'data/application.sqlite',
});

// Wire this only to a principal created by real session/token verification.
const resolvers = createApplicationContextResolvers({
  repository: applicationStore,
  getPrincipalId: verifiedPrincipal => authProviderAdapter.getStableUserId(verifiedPrincipal),
});
```

The authentication adapter in this example is intentionally a placeholder name, not an implemented provider. Configure the database path, backups, access permissions, and verified auth integration before running a server.

## Data model

- `app_circles`: application circle ID, NEAR contract account ID, and application status.
- `app_members`: canonical member ID, unique external principal ID, and unique NEAR account.
- `app_circle_memberships`: circle/member relationship and membership status.
- `app_rounds`: round index, status, required native-NEAR contribution in yoctoNEAR, and deadline timestamp in milliseconds.
- `app_circle_assets`: exact allowlisted provider asset IDs and maximum input amounts in that asset's base units.
- `app_member_refund_addresses`: verified refund address per member and asset.

An origin asset is enabled for quote creation only when the circle's asset policy is active **and** the member has an active refund address registered for that same asset. Amounts are kept as integer strings to avoid floating-point precision loss.

## Synchronization and security limitations

This store is an application metadata repository, not an on-chain state oracle. The app must synchronize circle IDs, contract IDs, members, round indices, deadlines, contribution amounts, and statuses with the deployed NEAR contract through a trusted creation/update workflow and read-only chain verification. A stale or incorrect mirror could otherwise cause an invalid quote or incorrect UI state. The current contract does not expose every metadata field needed to independently reconstruct the complete membership policy from chain views.

Before production: implement and test the selected real authentication provider; verify NEAR account ownership during member onboarding; define transactional synchronization and reconciliation against chain state; verify refund address ownership where feasible; protect database files and backups; add migrations, rate limiting, operational diagnostics, and end-to-end tests. No real authentication, live chain synchronization, API server, quote request, transaction, or deployment is included in this milestone.
