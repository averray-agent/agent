# Roadmap Update: Backup readiness evidence validation

- **Date:** 2026-05-24
- **Agent:** Codex / `codex/backup-readiness-evidence`
- **Roadmap section:** P0 Launch Gates
- **Item:** Postgres backup readiness / Redis backup readiness
- **Related PRs/issues:** [PR #507](https://github.com/averray-agent/agent/pull/507)
- **Proposed status:** Open
- **Owner:** Launch operator / roadmap steward

## Summary

This slice adds a read-only validator for saved
`check-backup-readiness.sh --json` output. It does not prove current production
backups by itself; it lets operators save the readiness JSON as an artifact and
verify that both Postgres and Redis components are `ok`, within the captured
age threshold, and recent enough for launch evidence.

## Evidence

- New validator: `scripts/ops/check-backup-readiness-evidence.mjs`.
- New focused tests: `scripts/ops/check-backup-readiness-evidence.test.mjs`.
- Checklist wiring: `docs/PRODUCTION_CHECKLIST.md` now shows saving and
  validating `docs/evidence/backup-readiness-YYYY-MM-DD.json`.

## Blockers Or Caveats

- The roadmap rows remain `Open` until the operator captures live production
  readiness evidence and validates it with `--max-checked-age-hours`.
- This does not replace the separate restore-drill proof.

## Requested Roadmap Change

Keep `Postgres backup readiness` and `Redis backup readiness` as `Open`. Once
validated production evidence exists, update the exact rows with the evidence
path, component file names, ages, and validator command output.
