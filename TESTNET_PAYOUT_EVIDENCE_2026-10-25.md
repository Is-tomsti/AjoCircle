# AjoCircle Testnet Payout Evidence - 2026-10-25

## Result

The Round 2 payout plan was reported as `FINALIZED` on NEAR testnet. The supplied result states that the transaction and finalized contract payout-complete state were independently verified.

- **Network:** NEAR testnet only
- **Plan ID:** `008b9356-b81b-4088-b392-1e933056493a`
- **Circle ID:** `7088fa1b-d174-40fb-9080-775867ebb5fc`
- **Contract:** `ajo-demo-fresh.testnet`
- **Contract code SHA-256:** `39e25e33b245cf6b1db3f4f3fbcec074796308d5741e4c058017123bbbc19674`
- **Round index:** `2` (third and final round)
- **Recipient:** `ajotest3.testnet`
- **Payout amount:** `3000000000000000000000000` yoctoNEAR (**3 NEAR**)
- **Transaction hash:** `HSCMVxa7ZcSSYsGaoA9rAcxWCSMD23uHVqbRycoctHT3`
- **Transaction signer:** `ajo-demo-fresh.testnet`
- **Transaction receiver:** `ajo-demo-fresh.testnet`
- **Method:** `release_payout`
- **Outcome:** `SUCCESS`
- **Verified at:** `2026-10-25T11:53:13.741Z`
- **Plan state:** `FINALIZED`
- **Payout pending:** `false`
- **Payout complete:** `true`
- **Circle completed:** `true`

## Finality evidence reference

`near-testnet:ajo-demo-fresh.testnet:HSCMVxa7ZcSSYsGaoA9rAcxWCSMD23uHVqbRycoctHT3:payout_complete=true:round=2:verifiedAt=1792929193738`

## Safety and follow-up

1. Do **not** resubmit this plan or retry the payout. It is already finalized.
2. Keep all remaining development and demonstrations on NEAR testnet; do not use mainnet funds.
3. Preserve this transaction hash and evidence reference in the hackathon demo notes.
4. Run regression tests and review the working-tree diff before committing. The working tree already contained many unrelated/uncommitted changes at the time this note was written; do not stage or commit everything indiscriminately.
5. No new contract deployment or contract modification is required to record this successful payout.

## Evidence provenance

This note records the payout result JSON supplied in the project conversation on 2026-10-25. Treat the fields above as the reported verification result; re-query NEAR testnet independently if a fresh external confirmation is required.
