
## Isolated offline mock provider

`mock-oneclick-quote-provider.mjs` is a deterministic test double for local tests only. It performs no network requests, only accepts explicit `dry: true` requests, never returns deposit instructions, and refuses committed quotes. Its output amounts are synthetic placeholders, not market estimates.

Run its focused tests from the `settlement-adapter` directory:

```powershell
node --test .\mock-oneclick-quote-provider.test.mjs
```

Do not wire this test double into the browser-facing quote preview route: doing so could make synthetic amounts look like a real provider estimate. Keep the existing preview route pointed only at the real provider in the separately approved environment, or clearly separate any mock UI behind an explicit development-only label and configuration. This module does not alter the current testnet server or database.
