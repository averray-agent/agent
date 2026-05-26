# Roadmap Update: Orphaned old EscrowCore balance audit

- **Date:** 2026-05-26
- **Agent:** Codex / `codex/orphaned-balances-audit-and-runbook-hardening`
- **Roadmap section:** P0 Launch Gates / Audit remediation follow-ups
- **Item:** 2026-05-25 old EscrowCore orphaned USDC balances
- **Related PRs/issues:** current PR
- **Proposed status:** Done
- **Owner:** Roadmap steward

## Summary

This slice verifies the old EscrowCore tail state left by the 2026-05-25
cutover, documents that normal old-escrow release is blocked after the old
contract was revoked from `TreasuryPolicy.serviceOperators`, and recommends
accepting the sub-dollar testnet loss rather than running a multisig recovery.
It also adds a pre-retirement orphan-balance guard to the EscrowCore redeploy
runbook so future retirements fail loudly when unsettled old jobs still touch
`AgentAccountCore` reserved or locked-stake balances.

## Evidence

- Read-only chain evidence:
  `docs/evidence/orphaned-balances-2026-05-26.json`.
- Audit trail update:
  `docs/AUDIT_REMEDIATION.md`.
- Operator runbook guard:
  `scripts/ops/redeploy-escrowcore.mjs`.
- Focused test coverage:
  `node --test scripts/ops/redeploy-escrowcore.test.mjs`.

## Blockers Or Caveats

- No funds were moved and no recovery was attempted. The documented
  recommendation is accepted testnet loss for `0.460001` USDC.
- The guard prevents silent future retirements, but operators can still bypass
  with `--acknowledge-orphaned-balances` after explicit review.

## Requested Roadmap Change

Mark the 2026-05-25 `AUDIT_REMEDIATION` follow-up for old EscrowCore orphaned
balances as closed after this PR merges. Keep the evidence link in the
canonical roadmap or launch-gate notes if the steward wants this visible during
mainnet readiness review.
