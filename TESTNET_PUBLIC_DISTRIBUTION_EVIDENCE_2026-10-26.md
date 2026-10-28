# AjoCircle Public Distribution Reconciliation Evidence — 2026-10-26

## Result

The application’s authenticated Public Distribution — Status flow returned `assessment.status = COMPLETE` for the plan below. The response reports the execution ledger as `FINALIZED`, independently verified recipient totals, on-chain distribution index `3`, `pending = false`, and `complete = true`. The status request itself submitted no transaction (`transactionSubmitted = false`). This is the supplied application reconciliation evidence; the values below should not be described as independently re-fetched from an external explorer in this document.

- **Network:** NEAR testnet only
- **Plan ID:** `6d68e4db-db7f-43fa-a3c5-8279c9ad1d97`
- **Circle ID:** `4b2c6821-df86-41f8-b29e-8eaffbce7ec0`
- **Contract:** `ajo-contrib-20261025.testnet`
- **Contract code SHA-256:** `f0f587a8e94c6206d6e73bd8a5b493763addcd972ceab33396302fd99f3bd545`
- **Round index:** `2`
- **Prepared by:** `ajotest1.testnet`
- **Authorized by:** `ajotest2.testnet`
- **Total planned distribution:** `9000000000000000000000000` yoctoNEAR = **9 NEAR**
- **Ledger state:** `FINALIZED`
- **Assessment:** `COMPLETE`
- **On-chain distribution index:** `3`
- **Pending:** `false`
- **Complete:** `true`
- **Failure reason:** `null`
- **Status checked / record updated at:** `2026-10-26T22:18:09.953Z`

## Recipients and verified totals

| Recipient | Planned amount | Reported verified total |
|---|---:|---:|
| `ajotest1.testnet` | 3 NEAR | 3 NEAR |
| `ajotest2.testnet` | 3 NEAR | 3 NEAR |
| `ajotest3.testnet` | 3 NEAR | 3 NEAR |
| **Total** | **9 NEAR** | **9 NEAR** |

Amounts per recipient are `3000000000000000000000000` yoctoNEAR.

## Finalized transaction evidence

1. `start_public_distribution` — tx `qAoza8KxUHy2uemQvJkNqvrfYdKHnW6nLfnzVqPcP7H` — [NEAR testnet explorer](https://explorer.testnet.near.org/transactions/qAoza8KxUHy2uemQvJkNqvrfYdKHnW6nLfnzVqPcP7H)
2. `continue_public_distribution` — tx `4EkABcihByqDnigFu5z9DTsWscimE3CZC2ac342yqmkh` — [NEAR testnet explorer](https://explorer.testnet.near.org/transactions/4EkABcihByqDnigFu5z9DTsWscimE3CZC2ac342yqmkh) — recipient receipt for `ajotest2.testnet` reported successful, no receipt failures.
3. `continue_public_distribution` — tx `C8K8WLYDFVbMZicCZESnnnzDzxiSuCRkDTmb5WpoRk9C` — [NEAR testnet explorer](https://explorer.testnet.near.org/transactions/C8K8WLYDFVbMZicCZESnnnzDzxiSuCRkDTmb5WpoRk9C) — recipient receipt for `ajotest3.testnet` reported successful, no receipt failures.

The status response lists all three transaction hashes with finalized evidence and says every recipient transfer was independently verified by the application assessment. The status response is the source for this record; explorer links are included for follow-up review.

## Safety / next steps

- Do **not** resubmit, restart, or continue this distribution plan. It is reported complete and finalized.
- Do not submit further fund-moving transactions for this plan.
- Keep all development and demos on NEAR testnet; never use mainnet funds.
- Preserve the original `TESTNET_PAYOUT_EVIDENCE_2026-10-25.md`; this file records a separate plan/circle and does not replace the older evidence.
- Use this record to support end-to-end test documentation and the hackathon demo checklist. Do not overstate it as proof of production readiness, a security audit, or completed cross-chain settlement.
