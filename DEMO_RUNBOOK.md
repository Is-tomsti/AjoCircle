# AjoCircle Demo Runbook

Use this runbook to record a truthful demonstration of the current USDC-denominated AjoCircle Testnet prototype. Capture the running application and genuine evidence. Never create fake memberships, payment receipts, balances or transaction results to make a demo look complete.

## Product being demonstrated

AjoCircle supports Ajo/Esusu savings circles with USDC-denominated member accounting on NEAR Testnet. Users can authenticate through Google/email using NEAR FastAuth or connect an existing NEAR wallet where the wallet/action path is supported. The one-time entry fee is 0.25 USDC per member per circle. The platform's eligible distribution fee is 0.5% and is accrued only after a successful USDC distribution transfer.

The intended member gas experience is sponsored: the member authorizes an eligible action and AjoCircle's relay pays the NEAR gas. **The backend relay and frontend release flag remained disabled at the latest verified checkpoint, and a real-wallet zero-member-NEAR journey had not passed end-to-end acceptance.** Say this clearly; do not stage or imply an activated gasless flow.

## Suggested recording sequence

1. Show the AjoCircle landing and explain that savings and contributions are denominated in USDC.
2. Demonstrate the available authentication choices: Google/email FastAuth Testnet and existing NEAR wallet, only where actually working in the current build.
3. Show Discover/public circle information and explain that users review circle rules, schedules and fees before joining.
4. Explain the separation between joining and the one-time 0.25 USDC entry-fee payment. Only show a payment as completed when the deployed contract and finalized Testnet evidence confirm it.
5. Show the deployed USDC Testnet contract and its finalized code-upgrade transaction: https://explorer.testnet.near.org/transactions/7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B
6. Clearly distinguish contract deployment and automated tests from a live member contribution or payout. At the latest recorded read-only check, no active circle summaries or USDC liabilities were present.
7. Close with the current release boundaries: Testnet only, relay activation still gated, no real funds, unaudited prototype.

## Recording safeguards

- Use Testnet only. Do not use a Mainnet wallet, token, RPC or credential.
- Never expose passwords, seed phrases, private keys, session tokens, provider credentials, database paths or environment-variable values.
- Do not sign or submit a wallet action just for the recording.
- Do not claim that a quote, prepared action, mock response or code deployment is a settled USDC contribution.
- Label synthetic/local test data as synthetic/local test data.
- Preserve the distinction between implemented, tested, deployed and activated capabilities.

## Public demo-post wording

Use accurate wording that describes the work actually completed during the hackathon. Do not claim that all prior development happened during the event. Attach the real video or screenshots from the recording, and do not claim a completed sponsored-gas journey or live USDC payout unless it is demonstrated by fresh, verifiable Testnet evidence.
