# Roadmap Update: Hardware MFA Proof Freshness

- **Date:** 2026-05-24
- **Agent:** codex/hardware-mfa-proof-freshness
- **Roadmap section:** Auth, Secrets, And Capability Roadmap
- **Item:** Hardware MFA for admin chain accounts
- **Related PRs/issues:** [PR #512](https://github.com/averray-agent/agent/pull/512)
- **Proposed status:** Ready for proof
- **Owner:** Operator

## Summary

The hardware-MFA evidence validator now supports an explicit max-age gate for
launch proof artifacts. This keeps older enrollment records useful as audit
history while requiring a fresh, dated operator artifact before the admin trust
chain can move to `Proofed`.

## Evidence

- Updated script: `scripts/ops/check-hardware-mfa-evidence.mjs`
- Updated tests: `scripts/ops/check-hardware-mfa-evidence.test.mjs`
- Updated launch/runbook command:
  `node scripts/ops/check-hardware-mfa-evidence.mjs --file docs/evidence/hardware-mfa-YYYY-MM-DD.json --max-completed-age-hours 30 --json`

## Blockers Or Caveats

- The roadmap row remains `Ready for proof` until the operator captures a
  sanitized live evidence artifact and validates it with the max-age gate.
- The evidence file must not contain recovery codes, provider tokens, private
  keys, JWTs, or raw recovery material.

## Requested Roadmap Change

Keep `Hardware MFA for admin chain accounts` as `Ready for proof`. Once live
evidence exists, cite the artifact path, validation command, operator signature,
and backup-key login-test coverage before moving the item to `Proofed`.
