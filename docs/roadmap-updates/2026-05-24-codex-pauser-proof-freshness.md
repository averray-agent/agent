# Roadmap Update: Pauser Proof Freshness

- **Date:** 2026-05-24
- **Agent:** codex/pauser-proof-freshness
- **Roadmap section:** P0 Launch Gates
- **Item:** Control-plane pauser / Pause-unpause rehearsal
- **Related PRs/issues:** [PR #514](https://github.com/averray-agent/agent/pull/514)
- **Proposed status:** Ready for proof
- **Owner:** Operator

## Summary

The pauser rehearsal evidence validator now supports an explicit max-age gate
for launch proof artifacts. This keeps older read-only and live rehearsal files
available as audit history while requiring fresh evidence before the
control-plane pauser and pause/unpause checklist boxes are closed.

## Evidence

- Updated script: `scripts/ops/check-pauser-rehearsal-evidence.mjs`
- Updated tests: `scripts/ops/check-pauser-rehearsal-evidence.test.mjs`
- Updated checklist command:
  `node scripts/ops/check-pauser-rehearsal-evidence.mjs --file docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json --require-live --max-generated-age-hours 30`

## Blockers Or Caveats

- The roadmap rows remain `Ready for proof` until the operator captures a live
  testnet pause/unpause artifact and validates it with the max-age gate.
- Mainnet or real-funds proof must also use `--require-dedicated-pauser`.

## Requested Roadmap Change

Keep `Control-plane pauser` and `Pause/unpause rehearsal` as `Ready for proof`.
After live evidence exists, cite the artifact path, validation command, pause
tx hash, unpause tx hash, and dedicated-pauser result before moving either row
to `Proofed`.
