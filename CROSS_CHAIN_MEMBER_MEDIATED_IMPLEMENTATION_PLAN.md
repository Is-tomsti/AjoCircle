# AjoCircle member-mediated contribution flow — implementation gate

## Status

Design checkpoint only. No contract, database, wallet, provider, or transaction state is changed by this document.

The current NEAR testnet contract accepts contributions through a payable `contribute()` call and requires the exact native-NEAR contribution amount attached to that call. The current 1Click adapter's destination is `nep141:wrap.near` and the recipient is the member's NEAR account. A successful swap or wrapped-NEAR delivery is not a contract contribution.

## Chosen direction

Preserve the existing contract semantics. Implement a member-mediated flow before considering any contract token-accounting changes:

1. Authenticate the member using the existing NEP-413 session flow.
2. Resolve the member, circle, current round, contribution amount, and deadline from trusted application state and fresh read-only testnet verification.
3. Enable only provider-supported origin assets that have a legitimate, verified refund destination for that member.
4. Offer an estimate-only preview (`dry: true`) first. The preview must not persist a settlement intent, expose deposit instructions, or claim contribution readiness.
5. Only in a separately approved live-settlement environment, create a committed 1Click quote and display its deposit instructions. Never treat that intent as a contribution.
6. Verify swap delivery independently using trusted provider evidence. Do not increment contribution counts or alter contract state based on a quote, intent, or swap alone.
7. The member must receive the wrapped NEAR, unwrap it through a supported wallet flow, and explicitly sign a native-NEAR `contribute()` transaction with the exact required attached deposit.
8. Confirm the contribution through finalized read-only contract state and transaction evidence before the application displays it as contributed.
9. Keep quote status, swap-delivery status, wallet action status, and on-chain contribution status as distinct states. Handle expiry, partial delivery, failed swaps, duplicate callbacks, and replay safely.

## Configuration requirements

The current application database has no active origin-asset records and no refund-address records for the active circle. The API handler does not expose a configuration route for these tables.

Do not resolve this by inserting rows directly or by inventing a wallet address. Before a configuration UI/API is added:

- Define which origin-chain assets and address formats are actually supported by the chosen 1Click integration.
- Establish a server-authorized circle-creator workflow for enabling an asset and setting conservative input limits.
- Establish a member-authorized proof-of-control workflow for registering a refund address for each origin asset. A text field alone is not proof of wallet ownership.
- Bind configuration writes to the authenticated principal and active membership; reject client-supplied member IDs, unchecked asset IDs, and arbitrary limits.
- Record audit metadata, use transactional writes, and test unauthorized changes, unsupported assets, malformed addresses, and duplicate requests.
- Keep provider credentials server-side only. Never expose tokens, session secrets, private keys, or wallet credentials in browser output or logs.

## Safety gates

- Testnet only; do not use mainnet funds.
- No live deposit, contribution, reserve funding, or payout as part of integration tests.
- Never bypass wallet authentication or contract authorization.
- Never fabricate member acceptance, refund-address verification, contribution evidence, or payout status.
- Do not add a 1Click JWT to the current testnet app merely to make a committed quote pass. A committed quote can produce real deposit instructions, and the current destination does not meet the contract's native-NEAR contribution requirement.
- Do not change the deployed contract or extend deadlines to work around this adapter mismatch.
- Keep `contributionReady: false` for quote previews until a real native-NEAR contribution is independently confirmed on chain.

## Acceptance criteria before implementation is considered complete

- Authenticated member can only configure assets and refund addresses for themselves or an authorized circle they administer.
- Refund address registration requires a verifiable proof-of-control for its origin chain.
- Preview tests assert `dry: true`, no settlement intent persistence, and no deposit-address leakage.
- Quote and swap states cannot be mistaken for contribution states in API responses or UI.
- Native contribution requires the member's explicit wallet signature and exact attached deposit.
- Finalized contract read confirms the member's contribution before the UI marks it complete.
- Failure, timeout, replay, duplicate callback, expiry, and insufficient-output tests all fail closed.
- All existing Node, Rust adapter, contract, and frontend build tests pass.
