# Roadmap Update: Observability Proof Artifact

- **Date:** 2026-05-22
- **Agent:** codex/observability-rc1-proof
- **Roadmap section:** P0 Launch Gates
- **Item:** Metrics auth / Sentry/logging decision / Alert destination
- **Related PRs/issues:** pending PR from `codex/observability-rc1-proof`
- **Proposed status:** Ready for proof
- **Owner:** Operator

## Summary

The implementation gates for metrics auth, Sentry/logging posture, and hosted
alert delivery already exist. This slice adds the missing machine-readable
evidence envelope so the operator can record one dated proof artifact before
the three observability rows move to `Proofed`.

## Evidence

- New script: `scripts/ops/check-observability-proof.mjs`
- New tests: `scripts/ops/check-observability-proof.test.mjs`
- Updated runbook: `docs/OBSERVABILITY_POSTURE.md`
- Updated checklist note: `docs/PRODUCTION_CHECKLIST.md`

## Blockers Or Caveats

- The roadmap rows should remain `Ready for proof` until the operator configures
  production `METRICS_BEARER_TOKEN` and `ALERT_WEBHOOK_URL`, runs the hosted
  metrics-auth gate, confirms one deliberate alert delivery, verifies the
  active Sentry/logging posture, and records a validated
  `docs/evidence/observability-YYYY-MM-DD.json` artifact.

## Requested Roadmap Change

Do not mark `Metrics auth`, `Sentry/logging decision`, or `Alert destination`
`Proofed` from this tooling PR alone. After live operator evidence exists,
update those exact rows with the evidence artifact path, metrics HTTP statuses,
alert message id/channel, Sentry/logging decision, and validation command
output.
