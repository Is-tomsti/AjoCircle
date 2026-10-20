# Cross-chain contribution integration checkpoint

## Verified current contract behavior

`Circle::contribute()` is payable. It identifies the member using `env::predecessor_account_id()` and requires `env::attached_deposit().as_yoctonear()` to equal the configured contribution amount exactly. A 1Click swap status alone cannot satisfy these checks.

## Verified 1Click settlement boundary

The settlement adapter verifies that a swap reached its destination, including destination asset, recipient, minimum output, and transaction evidence. It deliberately does not credit a circle or authorize payout.

## Integration blocker to resolve before quote creation

The common NEAR fungible-token asset `nep141:wrap.near` is wrapped NEAR, while the current contribution method expects native NEAR attached to a member-originated contract call. Sending wrapped NEAR to the contract or marking a successful swap as a contribution would not satisfy the existing contract rules.

## Safe integration choices to evaluate

1. **Member-mediated flow:** quote wrapped NEAR to the member's NEAR account; verify delivery; have the member unwrap and call `contribute()` with the exact native NEAR amount. This preserves current contract semantics but is not fully automatic.
2. **Contract-supported token flow:** explicitly design and test a `wrap.near` token contribution path, including sender/member attribution, exact amount accounting, and token-denominated payouts/refunds. This is a wider contract change and requires careful security review.
3. **TEE-attested contribution flow:** only consider if the settlement proof, authorization model, and actual funds custody/transfer into the circle are defined. A TEE attestation by itself does not move funds or make the contract balance sufficient for payouts.

## Rule

Do not create a production quote-to-contribution workflow or display a swap as a completed contribution until one of these paths is selected and its invariants are tested. The current adapter remains a settlement-verification prototype.
