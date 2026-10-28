# AjoCircle Demo Runbook

Use this runbook to prepare a truthful 60–90 second hackathon demo. Record the actual running app and actual testnet evidence. Do not fabricate a quote, transaction, membership, verification, or on-chain result.

## Recording checklist

- Use the existing project and existing testnet contracts; do not redeploy just to make the footage look cleaner.
- Close terminals that might expose environment variables, session tokens, local database paths, account secrets, or wallet private-key material.
- Use NEAR testnet only. Do not open a transaction confirmation dialog unless you are deliberately doing an authorized testnet action and understand the exact call, account, amount, and recipient.
- Keep the user interface and browser address bar legible. Do not edit the recording to imply that a historical transaction belongs to the current Oct24 circle.
- If the quote preview is shown, the screen must visibly say the offline estimate is synthetic and not a market price. It targets wrapped NEAR and is not proof of a contract contribution.

## Suggested 75-second sequence

| Time | Capture | Narration | What it demonstrates |
| --- | --- | --- | --- |
| 0–10s | AjoCircle landing/member UI | “AjoCircle brings Ajo/Esusu savings-circle rules into a NEAR smart contract.” | Product and target users |
| 10–25s | Source README or test run showing contract/adapter suites | “Membership, fixed contributions, payout order, treasurer permissions, and protection rules are covered by automated tests.” | Reproducible engineering, not a claim of audit |
| 25–45s | Open the historical 3 NEAR testnet payout transaction in the explorer | “This separate earlier testnet demo recorded a finalized 3 NEAR payout and completed-circle state.” | External testnet evidence; name the historical contract `ajo-demo-fresh.testnet` |
| 45–58s | Open public-distribution evidence/transaction links | “A separate testnet distribution plan reports 3 NEAR each to three recipients; the evidence note explains its source.” | Distribution prototype; do not imply independent explorer verification beyond what the note supports |
| 58–70s | Member quote-preview form/result, if signed into the local test environment | “The preview boundary is separate from contribution. Offline mode is synthetic; live 1Click previews are isolated from the testnet circle.” | Scope honesty and fail-closed behavior |
| 70–75s | End card / README quickstart | “AjoCircle is testnet-only and unaudited; broader cross-chain settlement and AI treasury remain future work.” | Honest state and next steps |

## Evidence URLs

- Historical 3 NEAR payout: https://explorer.testnet.near.org/transactions/HSCMVxa7ZcSSYsGaoA9rAcxWCSMD23uHVqbRycoctHT3
- Public distribution start: https://explorer.testnet.near.org/transactions/qAoza8KxUHy2uemQvJkNqvrfYdKHnW6nLfnzVqPcP7H
- Public distribution continuation: https://explorer.testnet.near.org/transactions/4EkABcihByqDnigFu5z9DTsWscimE3CZC2ac342yqmkh
- Public distribution final continuation: https://explorer.testnet.near.org/transactions/C8K8WLYDFVbMZicCZESnnnzDzxiSuCRkDTmb5WpoRk9C

These are separate historic testnet circles/plans, not the active Oct24 circle. Read the linked evidence files for provenance and don't resubmit the completed plans.

## X post template — do not publish until the event-period work and demo are real

> Built at NEAR HACKATHON: AjoCircle is a NEAR-based Ajo/Esusu savings-circle prototype for transparent contributions and controlled payouts. During the hackathon we [describe the specific work actually completed during the official build window]. The contract enforces fixed contribution amounts and payout-order/treasurer rules; our testnet demo includes [linkable evidence you actually show]. Testnet only, unaudited, and no real funds. Cross-chain contribution settlement and AI treasury automation are not yet complete.

Attach the actual demo video or screenshots. Replace every bracketed part with a fact visible in the recording. Do not publish the post until the required project work has actually been done during the official hackathon period; substantial AjoCircle development predates 1 November 2026, so confirm eligibility/wording if uncertain. The owner must publish the post themselves and then provide the public URL.

## Hard boundaries

Do not claim production readiness, independent audit, autonomous AI treasury, a complete cross-chain contribution, or mainnet custody. A successful swap/quote is not a contribution. Only contract-authoritative state and verified finalized native-NEAR contribution evidence count as contributions.