# Catalogue budget change: operator-supplied chain estimate

Pascal supplied this export on 2026-11-03. Source: signer-posted JobCreated
on EscrowCore v3, blocks 22078913–22667986, 2026-10-20 19:37Z through
2026-11-03 19:37Z. Reproducer: `.scratch/catalogue-exposure-14d.mjs` in the
operator's worktree (not executed by this implementation).

| Date (UTC) | Claims | Reserved USDC | Peak rolling 24h USDC | Refused at 5 USDC |
|---|---:|---:|---:|---:|
| 2026-10-21 | 2 | 1.10 | 1.10 | 0 |
| 2026-10-22 | 3 | 2.10 | 3.10 | 0 |
| 2026-10-23 | 2 | 1.10 | 3.10 | 0 |
| 2026-10-26 | 7 | 7.00 | 7.00 | 2 |
| 2026-10-27 | 1 | 1.00 | 8.00 | 1 |
| 2026-11-03 | 2 | 2.00 | 2.00 | 0 |
| Total | 17 | 14.30 | — | 3 |

Other dates in the window had no events, per the export. The replay admits
14 claims and refuses 3 claims (3 USDC); refused claims do not enter its
rolling window. This is a chain estimate, not a session-budget audit.

The application counts `catalogueDailyBudget.candidate.reservedRewardUsdc +
brokeredGasUsdc` from durable sessions (`catalogue-daily-budget.js`,
`worker-exposure.js`), whereas the export counts on-chain `totalReserved`.
These are distinct measures: bank reservations include contract fees/reserves,
while application exposure includes its brokered gas estimate. No equality or
individual 10-26 session reconciliation is claimed. Admin-created jobs can
also emit signer-posted JobCreated (`platform-service.js` calls `ensureJob`
at creation), so this is an upper bound on catalogue event counts. No admin
credentials or production access were used.
