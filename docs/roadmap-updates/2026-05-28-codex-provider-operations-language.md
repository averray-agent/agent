# Roadmap Update: A6 - Provider Operations operator-language pass

- **Date:** 2026-05-28
- **Agent:** codex/provider-operations-language
- **Roadmap section:** Control-Room UI Review Intake (2026-05-27)
- **Item:** A6 - Provider Operations operator-language pass
- **Related PRs/issues:** https://github.com/averray-agent/agent/pull/587
- **Proposed status:** Done after merge
- **Owner:** Frontend / roadmap steward

## Summary

The Provider Operations overview rows translate scheduler counters into
operator-facing labels: `Found upstream`, `Opened as jobs`, `Safely ignored`,
and `Needs attention`. The row no longer renders the backend-provided
`candidate(s), created, skipped, error(s)` summary directly, and detailed skip
reasons are grouped under a visible `ignored because:` label.

## Evidence

- `app/components/overview/ProviderOperationsCard.tsx` renders the operator
  language legend and derived summaries.
- `app/lib/ui/provider-operation-language.js` owns the scan-friendly wording.
- `app/lib/ui/provider-operation-language.test.mjs` proves the summary strings
  do not contain the raw backend counter words.
- Local checks:
  - `npm run test:app`
  - `npm run typecheck:app`
  - `npm run build:frontend`

## Blockers Or Caveats

- The PR intentionally does not commit generated `frontend/` output; production
  deploy rebuilds it.
- Hosted/live screenshot proof is still useful after merge, but the roadmap
  row's verification path allows component-test evidence.

## Requested Roadmap Change

After this PR merges, move `A6 - Provider Operations operator-language pass`
from `Open` to `Done` and cite the merged PR plus the component-test evidence.
