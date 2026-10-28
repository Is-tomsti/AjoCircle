# NEAR Wallet Sign-In (NEP-413)

## Status

This is a provider-neutral authentication implementation with a NEAR wallet sign-in provider. It is suitable for continued local/testnet hackathon integration, not yet a production deployment. It uses Node's built-in crypto and `node:sqlite`; it does not require an email/SMS provider or send an on-chain transaction.

## Flow

1. `POST /api/auth/near/challenge` with `{}`. The server stores a random 32-byte nonce, a fixed recipient, exact message text, and a short expiry in SQLite. The response contains the challenge fields the wallet needs to sign.
2. The browser asks a NEP-413-capable wallet to sign the returned `message`, `recipient`, and 32-byte nonce. Convert the base64 nonce to a byte array/Buffer for the wallet SDK. The wallet returns `accountId`, `publicKey`, and base64 `signature`.
3. `POST /api/auth/near/verify` with `nonce`, `accountId`, `publicKey`, `signature`, `message`, and `recipient`.
4. The server reconstructs the NEP-413 Borsh payload and SHA-256 digest, verifies the Ed25519 signature, queries NEAR RPC for the account's access-key list, requires that exact public key to be a **FullAccess** key, checks the configured suspension callback, and atomically consumes the nonce.
5. The server returns a short-lived HS256 JWT. Pass it as `Authorization: Bearer <token>` on protected requests. Do not trust a browser-supplied subject or decode an unverified token.
6. `createHmacSessionTokenVerifier()` validates this application's JWT signature, issuer, audience, issue/expiry times, and suspension callback. Pass that verifier into `createBearerSessionAuthenticator()` and the resulting `authenticateRequest` callback into `createMemberQuoteHandler()`.
7. Authentication is not circle authorization. `createApplicationContextResolvers()` and the authoritative SQLite membership/round/asset/refund-address checks remain required for quotes.

## Configuration

Create `NearWalletAuthStore` using a durable, access-controlled SQLite file path (not `:memory:`) for a persistent deployment. Configure `createNearWalletAuthService` with:

- `rpcUrl`: trusted NEAR RPC URL for the intended network.
- `recipient`: exact fixed app origin/domain that the wallet shows the user; never accept this from the client.
- `sessionSecret`: cryptographically random secret of at least 32 bytes, stored only in server-side secret management.
- `issuer` and `audience`: stable values unique to the deployment.
- `isAccountSuspended`: server-side check that fails closed if the account is suspended. Membership status is separately checked on every protected circle operation.

Example composition:

```js
const authStore = new NearWalletAuthStore({ path: process.env.AJO_AUTH_DB_PATH });
const authService = createNearWalletAuthService({
  store: authStore,
  rpcUrl: process.env.NEAR_RPC_URL,
  recipient: process.env.AJO_AUTH_RECIPIENT,
  sessionSecret: process.env.AJO_SESSION_SECRET,
  issuer: process.env.AJO_SESSION_ISSUER,
  audience: process.env.AJO_SESSION_AUDIENCE,
  isAccountSuspended: accountId => accountSuspensionRepository.isSuspended(accountId),
});
const authHandler = createNearWalletAuthHandler({ service: authService });
const verifyBearerToken = createHmacSessionTokenVerifier({
  sessionSecret: process.env.AJO_SESSION_SECRET,
  issuer: process.env.AJO_SESSION_ISSUER,
  audience: process.env.AJO_SESSION_AUDIENCE,
  isAccountSuspended: accountId => accountSuspensionRepository.isSuspended(accountId),
});
const authenticateRequest = createBearerSessionAuthenticator({ verifyBearerToken });
```

The `accountSuspensionRepository` above is an application-provided trusted server-side dependency; it is not implemented or provisioned by this module. Do not use the example until that dependency is wired to real policy data. Ensure the same trusted issuer/audience/secret and suspension policy are used by both token issuance and verification.

## Security boundaries and known limits

- Current signature verifier supports **Ed25519 FullAccess keys only** and deliberately rejects other key types or function-call keys.
- RPC key membership is checked against the configured network. Never mix mainnet and testnet RPCs for the same auth deployment.
- Challenge nonces are stored hashed and atomically consumed; SQLite must be durable and shared by all app instances for replay prevention to work across instances. Use a single shared durable database or a transactional shared store for multi-instance deployment.
- The HTTP handler applies an in-memory limit of 10 challenge requests per remote IP per 60 seconds and returns `429 CHALLENGE_RATE_LIMITED`. This is per process, not distributed; configure trusted-proxy IP handling and a shared rate limiter before multi-instance/public production use. Do not trust arbitrary `X-Forwarded-For` values.
- `NearWalletAuthStore.deleteExpiredChallenges(atMs)` removes expired challenge rows. The loopback-only `near-wallet-auth-testnet-server.mjs` runs this cleanup every 60 seconds. Production must run monitored cleanup as a scheduled task and alert on failures.
- Add monitoring, abuse controls, TLS, and deployment-specific origin/CSRF protections before public exposure.
- The bearer token is returned in the response. The frontend must keep it out of URLs, logs, analytics, and unsafe persistent browser storage; prefer an appropriately configured HttpOnly Secure cookie if the deployed app's session architecture supports it.
- Add key rotation, explicit logout/revocation policy, and robust suspension repository semantics before production. The current verifier checks the account suspension callback on each bearer verification, but does not maintain a general per-token revocation list.
- A testnet wallet-selection frontend now lives in `web/` and uses HOT Connect's manifest feature filter for `signMessage`, `signInAndSignMessage`, and `testnet`. This frontend has not yet passed real-wallet interoperability tests; unsupported wallets must show a clear fallback rather than pretending sign-in succeeded.
- Tests generate local ephemeral Ed25519 keys and mock NEAR RPC. They validate implementation behavior but do not replace testnet wallet interoperability testing.
- No private wallet key is requested, stored, or sent to the server. No transaction is submitted by sign-in.

## Tests

Run all adapter tests from PowerShell:

```powershell
node --test (Get-ChildItem -Path '.\settlement-adapter' -Filter '*.test.mjs' | ForEach-Object FullName)
```

## HTTP route composition

`createAjoApiHandler({ authHandler, memberQuoteHandler, fallbackHandler })` routes the two `/api/auth/near/*` paths to the wallet auth handler and `/api/member/quote` to the authenticated quote handler. An optional fallback handler can retain other existing API routes. Example:

```js
const apiHandler = createAjoApiHandler({
  authHandler: createNearWalletAuthHandler({ service: authService }),
  memberQuoteHandler: createMemberQuoteHandler({
    store: settlementStore,
    quoteClient,
    authenticateRequest,
    ...createApplicationContextResolvers({ repository: applicationStore, getPrincipalId: p => p.subject }),
  }),
  fallbackHandler: existingOtherRoutesHandler,
});
```

The example assumes `quoteClient`, `settlementStore`, `applicationStore`, and any fallback handler have already been configured server-side. Do not expose privileged provisioning methods from `ApplicationStore` as browser routes.
