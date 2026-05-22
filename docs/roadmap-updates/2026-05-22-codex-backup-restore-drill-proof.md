# Roadmap Update: Backup Restore Drill Proof

- **Date:** 2026-05-22
- **Agent:** codex/backup-restore-rc1-proof
- **Roadmap section:** P0 Launch Gates
- **Item:** Postgres backup readiness / Redis backup readiness / Restore drill
- **Related PRs/issues:** pending PR from `codex/backup-restore-rc1-proof`
- **Proposed status:** Open
- **Owner:** Operator

## Summary

The existing backup-readiness check already proves recent Postgres and Redis
backup files exist. This slice adds a machine-readable restore-drill evidence
validator so the operator can record the monthly disposable-target restore in a
form CI and reviewers can check before the roadmap row moves.

## Evidence

- New script: `scripts/ops/check-restore-drill-evidence.mjs`
- New tests: `scripts/ops/check-restore-drill-evidence.test.mjs`
- Updated runbook: `docs/BACKUP_RESTORE_DRILL.md`
- Updated checklist evidence requirement: `docs/PRODUCTION_CHECKLIST.md`

## Blockers Or Caveats

- The roadmap rows should stay `Open` until the operator runs the drill against
  current production backup copies, commits or otherwise records the validated
  `docs/evidence/restore-drill-YYYY-MM-DD.json` artifact, and cites the
  readiness JSON plus restore target/counts.

## Requested Roadmap Change

Do not mark `Postgres backup readiness`, `Redis backup readiness`, or
`Restore drill` Done/Proofed from this tooling PR alone. After live operator
evidence exists, update those exact rows with the evidence artifact path, backup
file names, Postgres row count, Redis `DBSIZE`, and validation command output.
