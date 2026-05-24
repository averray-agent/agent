# Roadmap Update: Dispute/arbitration semantics

- **Date:** 2026-05-24
- **Agent:** codex/dispute-arbitration-fields
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** Dispute/arbitration semantics
- **Related PRs/issues:** pending PR from `codex/dispute-arbitration-fields`
- **Proposed status:** Open
- **Owner:** roadmap steward

## Summary

This slice removes an operator-facing dispute semantics mismatch: the UI previously labeled the third verdict path as "Request more evidence", but submitted it as the backend `split` verdict, which resolves the dispute with a partial payout instead of pausing the window. The operator UI now presents that path as "Split payout", maps backend split/partial aliases back to the explicit split decision, and uses release amounts that mirror backend default split-payout semantics.

## Evidence

- Added `app/lib/api/dispute-verdicts.js` as a tested pure mapping layer for operator decisions, backend verdict tokens, and default release amount projection.
- Added `app/lib/api/dispute-verdicts.test.mjs` covering decision-to-verdict mapping, rejection of the old `request-more` decision token, legacy backend alias projection, and default split-payout amount behavior.
- Updated dispute drawer, decision panel, and stake hold UI copy so the displayed action matches the backend settlement behavior.

## Blockers Or Caveats

- This does not close the full dispute/arbitration semantics row. Remaining work includes hosted dispute verdict proof, explicit final `/release` semantics, arbitrator notification rehearsal, and any future true "request more evidence" backend state if the product still wants that action.
- Canonical roadmap was not edited because active route-split PRs are already touching the same roadmap section.

## Requested Roadmap Change

Append a short note to the `Dispute/arbitration semantics` row after this PR merges: "First UI-contract slice made the operator split-verdict path explicit and added mapping tests so the UI no longer labels backend `split` settlement as a request-more-evidence action."
