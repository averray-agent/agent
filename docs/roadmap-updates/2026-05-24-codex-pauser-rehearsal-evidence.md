# Roadmap Update: Control-plane pauser evidence validation

- **Date:** 2026-05-24
- **Agent:** Codex / `codex/pauser-rehearsal-evidence`
- **Roadmap section:** Launch-Critical P0
- **Item:** Control-plane pauser / Pause/unpause rehearsal
- **Related PRs/issues:** [PR #502](https://github.com/averray-agent/agent/pull/502)
- **Proposed status:** Ready for proof
- **Owner:** Roadmap steward and launch operator

## Summary

This slice adds a read-only validator for the JSON evidence emitted by
`scripts/ops/run-pauser-rehearsal.mjs`. It does not perform the live pauser
rehearsal or close the launch boxes by itself; it makes the read-only proof,
live pause/unpause proof, and dedicated-pauser requirements machine-checkable
before operators tick the production checklist.

## Evidence

- New validator: `scripts/ops/check-pauser-rehearsal-evidence.mjs`.
- New focused tests: `scripts/ops/check-pauser-rehearsal-evidence.test.mjs`.
- Checklist wiring: `docs/PRODUCTION_CHECKLIST.md` now shows validation
  commands for read-only and live evidence.

## Blockers Or Caveats

- The existing `docs/evidence/pauser-rehearsal-readonly-2026-05-21.json`
  validates the control-plane capability proof only.
- The `Pause/unpause rehearsal` row still needs a live testnet evidence file
  validated with `--require-live`.
- Mainnet or real-funds proof must also validate with
  `--require-dedicated-pauser`.

## Requested Roadmap Change

Keep both rows at `Ready for proof`, but add a note that proof artifacts should
be checked with `node scripts/ops/check-pauser-rehearsal-evidence.mjs` before
the steward moves either row to `Done` or `Proofed`.
