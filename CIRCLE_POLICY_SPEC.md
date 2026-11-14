# AjoCircle Circle Policy — USDC Testnet MVP

## Product and asset boundary

AjoCircle is a USDC-denominated Ajo/Esusu savings-circle application on NEAR Testnet.

- Member contributions, entry fees, payouts and distribution accounting use **USDC**.
- The configured USDC token has six decimals. Amounts are stored and transferred as integer base units; do not use floating-point arithmetic for money.
- Native NEAR is not a member contribution or savings asset. NEAR is the underlying network execution/gas asset.
- The one-time entry fee is **0.25 USDC per member per circle**.
- The platform distribution fee is **0.5% (50 basis points)** on eligible successful gross USDC distributions. It is accrued only after the relevant token transfer succeeds.

## Identity and joining

Users may authenticate with Google/email through NEAR FastAuth Testnet or connect a supported existing NEAR wallet. These are separate identity paths. Do not silently merge an email identity with a wallet identity.

Authentication does not itself join a circle, pay a fee, create an on-chain contribution, or authorize a transfer. The member must review the circle terms and explicitly authorize any wallet action.

Joining and paying the 0.25 USDC entry fee are distinct steps. The application must show fee status clearly and must not represent an unpaid member as fee-paid or financially eligible. A fee payment is complete only after the USDC contract and its transfer callback confirm the exact receipt.

## Circle modes

### Public circle

- Visible for discovery and open to eligible members while registration is open.
- The member reviews the amount, schedule, capacity, deadline and terms before joining.
- The contract enforces registration limits and the published circle configuration.
- Contributions are USDC NEP-141 transfers with a circle/round-bound message. A quote, prepared action, wallet authentication or UI state is not a contribution.
- Missing contributions are recorded against the published deadline. The public default/removal process is governed by the contract's missed-contribution scan and member voting rules.
- The contract's public-default process is not a guarantor or collateral system. AjoCircle does **not** promise that a member's missed contribution will be covered by another member's locked collateral or by a funded reserve.

### Private circle

- Invitation-only; an invitation is tied to the intended wallet identity and the circle.
- The invitee reviews and accepts the circle terms before joining.
- Contributions and round payouts follow the circle's configured schedule and contract checks.
- The creator cannot silently alter accepted terms after the circle starts.

## No guarantor or reserve-backed protection in the current MVP

Guarantor-backed collateral, guarantor nomination, locked guarantor deposits, reserve contributions, reserve claims, and a collateral-backed protection promise are **not part of the current AjoCircle USDC MVP**. They must not be presented as required to create/join a public circle, as an implemented feature, or as a guarantee against member default.

This is a deliberate product-scope decision. Any future collateral or reserve product would require a separate owner-approved design, contract implementation, adversarial testing, independent security review and explicit disclosure before it could be reconsidered.

## Gas sponsorship

The intended member experience is that members do not need to acquire NEAR or pay NEAR network gas for eligible AjoCircle actions. The member authorizes the operation; the AjoCircle sponsor/relay pays the eligible network gas.

This feature is **not marked live** in the current Testnet release. The latest recorded release checkpoint kept the backend relay and frontend activation gates disabled pending sponsor-key custody, spending limits/reserve policy and real-wallet acceptance. Do not claim a completed gasless member journey until new end-to-end evidence proves it.

## Settlement and fee accounting

- USDC transfer attempts are nonce/fingerprint bound and are persisted before dispatch.
- Member contribution and entry-fee records are distinct from platform distribution-fee accounting.
- The contract recognizes a distribution fee only after a successful eligible USDC transfer callback.
- A prepared or failed transfer must not be displayed as a completed contribution or payout.
- Retry operations use fresh nonces and must not duplicate an earlier transfer or fee accrual.

## Testnet and safety boundary

The current deployment is NEAR Testnet only. No real funds, Mainnet deployment, live payout activation, external withdrawal service, or activated sponsored-relay service is authorized by this specification. The contracts and application have not received an independent security audit.

Do not expose private keys, seed phrases, API credentials, session secrets, local databases or privileged server provisioning routes. Public-chain activity is visible; do not promise confidentiality for wallet accounts or on-chain membership and transaction records.
