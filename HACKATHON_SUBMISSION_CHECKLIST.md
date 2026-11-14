# AjoCircle — NEAR Hackathon 2026 Submission Checklist

**Repository:** https://github.com/Is-tomsti/AjoCircle  
**Network:** NEAR Testnet only  
**Member savings asset:** USDC

## Current project description

AjoCircle is an Ajo/Esusu rotating-savings application with member contribution and circle accounting denominated in USDC. Users can authenticate through Google/email using NEAR FastAuth or connect an existing NEAR wallet where that path is supported. The underlying execution network is NEAR; native NEAR is used for network gas, not as the member savings asset.

The current Segment 3 USDC contract is deployed at `ajocirclevault1.testnet`. The one-time entry fee is **0.25 USDC per member per circle**. The eligible distribution fee is **0.5% (50 bps)** and is accrued only after a successful eligible USDC distribution transfer.

AjoCircle's intended user experience is sponsored gas: the member authorizes an eligible action and the platform relayer pays NEAR gas. At the latest recorded acceptance checkpoint, the backend relayer and frontend release gates remained disabled, and a real-wallet zero-member-NEAR journey had not passed end-to-end acceptance. Do not claim the gasless journey is live until fresh evidence proves it.

## Submission checklist

- [ ] Confirm the current official hackathon submission form, track options and deadline.
- [ ] Confirm with the organisers that the project's pre-hackathon development history is eligible; accurately identify which work was completed during the event window.
- [ ] Keep the GitHub repository public and accessible to judges.
- [ ] Review the full Git history for credentials, wallet keys, seed phrases, tokens, personal data, local databases and private backups.
- [ ] Check that the root README, judge guide, demo runbook and public source all describe the USDC version.
- [ ] Run the current Segment 3 USDC contract tests, formatting and Clippy checks.
- [ ] Run settlement-adapter tests and the frontend production build.
- [ ] Verify the public Testnet deployment transaction and exact deployed code hash.
- [ ] Record a truthful demo of the UI and only those wallet/payment actions that work at recording time.
- [ ] Publish a public X post that follows the official event instructions and attach the actual demo video or screenshots.
- [ ] Submit the public repository URL and public demo-post URL through the official form.
- [ ] Save the submission confirmation and final links.

## Technical verification

Current USDC Testnet contract: `ajocirclevault1.testnet`  
Platform sponsor / contract owner: `ajocirclepot1.testnet`  
USDC token: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`  
Decimals: 6  
Entry fee: 0.25 USDC  
Distribution fee: 50 bps  
Finalized code-only upgrade: [Testnet transaction](https://explorer.testnet.near.org/transactions/7xqQUV7BgtoJhf2HFrRSkyPwjC3EawQWXmhKXvFdgN6B)

The recorded Segment 3 contract suite passed 88 tests with 0 failures and 2 ignored. Recorded relay/wallet tests passed 34/34, and the combined Segment 3 app-server/relay suite passed 66/66 at its checkpoint. These are local automated-test records, not proof of a live member transaction or an independent audit. The full frontend test sweep had outstanding unrelated failures at the last recorded UI checkpoint.

## Do not claim as complete without new evidence

- Live gasless member actions / activated sponsored relay.
- Completed real-wallet join, entry-fee, contribution and payout journeys.
- Production payout, public distribution, refund or external withdrawal activation.
- A fully integrated cross-chain contribution product.
- A production AI treasury agent with signing or transfer authority.
- A persistent on-chain reputation history or a complete credit/reputation product.
- Independent smart-contract audit or production readiness.

## Safety and disclosure

- Testnet only; no Mainnet funds or transactions.
- Do not fabricate membership, transaction, contribution, wallet-authentication or payment evidence.
- A contract deployment is not a member contribution or payout.
- The application and contracts are experimental and unaudited. Do not use real funds.
- AI-assisted development was used; disclose assistance as required by the event form/rules.
- The project code is licensed under MIT; third-party dependencies retain their own licences.
