# Member quote development HTTP server

`member-quote-dev-server.mjs` exports `startMemberQuoteDevServer({ handler, port })`. It wraps a fully configured `createMemberQuoteHandler(...)` in Node's HTTP server and binds exclusively to `127.0.0.1`. The default port is `0`, which asks the operating system for an available ephemeral port; this is intended for local development and tests.

The module deliberately does not create a default user, trust request headers, select an authentication vendor, or construct database and quote-provider credentials. The caller must supply the real member quote handler with all required authentication, identity, authoritative-context, durable-store, and quote-client dependencies. Startup fails if the handler is missing or the port is invalid.

Unexpected handler errors receive a generic `500 INTERNAL_ERROR` response with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; exception details are not returned to the client. This wrapper is not a production deployment or a substitute for authentication, authorization, TLS, rate limiting, monitoring, or secret management.

## Test

From the repository root:

```powershell
node --test .\settlement-adapter\member-quote-dev-server.test.mjs
```

The tests bind a real local HTTP listener and send a real local HTTP request. They use a test handler, so they do **not** prove that a real auth provider, application session, live 1Click credential, or production database is configured.

## Next integration requirement

Choose and configure an authentication provider, then write a small server-side adapter that verifies its session/token and returns a stable principal ID. Connect that adapter to `createApplicationContextResolvers` and the authoritative `ApplicationStore`; do not accept a client-provided member ID as proof of membership. Only then should the development server be started with the actual quote handler. Keep the listener on loopback until deployment and network exposure are separately reviewed.
