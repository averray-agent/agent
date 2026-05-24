# Roadmap Update: Observability Proof Freshness

- **Date:** 2026-05-24
- **Agent:** codex/observability-proof-freshness
- **Roadmap section:** P0 Launch Gates
- **Item:** Metrics auth / Sentry/logging decision / Alert destination
- **Related PRs/issues:** [PR #510](https://github.com/averray-agent/agent/pull/510)
- **Proposed status:** Ready for proof
- **Owner:** Operator

## Summary

The observability evidence validator now supports an explicit max-age gate for
launch proof artifacts. This keeps old evidence auditable while requiring the
operator to prove that metrics auth, alert delivery, and logging/Sentry posture
were observed recently before the roadmap rows move to `Proofed`.

## Evidence

- Updated script: `scripts/ops/check-observability-proof.mjs`
- Updated tests: `scripts/ops/check-observability-proof.test.mjs`
- Updated runbook/checklist command:
  `node scripts/ops/check-observability-proof.mjs --file docs/evidence/observability-YYYY-MM-DD.json --max-completed-age-hours 30 --json`

## Blockers Or Caveats

- The roadmap rows remain `Ready for proof` until the operator captures a live
  production evidence artifact and validates it with the max-age gate.

## Requested Roadmap Change

Keep `Metrics auth`, `Sentry/logging decision`, and `Alert destination` as
`Ready for proof`. When the live artifact exists, cite the artifact path,
validation command, metrics HTTP statuses, alert delivery details, and logging
decision before moving those rows to `Proofed`.
