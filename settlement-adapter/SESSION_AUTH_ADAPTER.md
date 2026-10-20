# Bearer Session Authentication Adapter

`session-auth-adapter.mjs` provides a provider-neutral boundary for authenticating the member quote endpoint. It is not an identity provider and does not verify JWT signatures by itself.

## Contract

Create the authenticator with `createBearerSessionAuthenticator({ verifyBearerToken, clock })` and pass its returned function as `authenticateRequest` to `createMemberQuoteHandler`.

The `verifyBearerToken(token)` callback must use the selected identity provider's trusted server-side SDK or verification library. It must verify token signature/authenticity, the expected issuer and audience, expiry, and applicable revocation/session rules. It must return verified claims with `subject` (the stable provider user ID) and `expiresAtMs` (an integer Unix timestamp in milliseconds). It must throw or return no valid result when verification fails.

The adapter strictly parses a single `Authorization: Bearer <token>` header, fails closed on verifier errors and expired sessions, and returns only `{ subject }`. It does not trust request-body identity fields, decode unverified tokens, or log bearer tokens.

## Security and integration status

- This adapter is provider-neutral scaffolding; no real provider SDK or credentials are configured here.
- Tests use a fake verifier and prove adapter behavior only. They do not establish real token authenticity or production login.
- Before any deployment, select an identity provider, implement `verifyBearerToken` with that provider's maintained server-side verification library, configure issuer/audience from trusted server configuration, and add provider-backed tests for bad signatures, wrong issuer/audience, expired/revoked sessions, and account suspension where supported.
- Wire the resulting principal into `createApplicationContextResolvers`; membership and refund addresses must still come from the authoritative application store. Authentication alone does not grant circle membership.
- Keep provider secrets in server-side environment/secret management. Never accept a verifier or identity claims supplied by the browser.
