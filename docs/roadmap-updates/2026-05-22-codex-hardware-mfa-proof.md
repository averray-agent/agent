# Roadmap Update: Hardware MFA Admin Trust Chain

- **Date:** 2026-05-22
- **Agent:** codex/hardware-mfa-rc1-proof
- **Roadmap section:** Auth, Secrets, And Capability Roadmap
- **Item:** Hardware MFA for admin chain accounts
- **Related PRs/issues:** current PR
- **Proposed status:** Ready for proof
- **Owner:** Pascal / roadmap steward

## Summary

This slice adds a machine-readable evidence validator for the Phase 4e hardware
MFA gate. It does not claim the operator accounts are already enrolled. It makes
the proof step explicit: every admin trust-chain account must have two hardware
keys enrolled, backup-key login tested, recovery material stored elsewhere, and
sanitized evidence committed before the item can move beyond Ready for proof.

## Evidence

- `scripts/ops/check-hardware-mfa-evidence.mjs` validates
  `hardware-mfa-evidence-v1` JSON artifacts.
- `scripts/ops/check-hardware-mfa-evidence.test.mjs` covers valid evidence,
  missing trust-chain accounts, single-key evidence, GitHub org-2FA gaps,
  registrar FIDO2 gaps, and secret-looking values accidentally pasted into the
  evidence file.
- `docs/PHASE_4E_PLAN.md` now names the evidence command and minimum JSON
  shape.
- `docs/PRODUCTION_CHECKLIST.md` now links hardware-MFA evidence validation as
  a mainnet sign-off blocker.

## Blockers Or Caveats

- Operator enrollment still has to happen outside the repo.
- Do not mark Proofed until a real `docs/evidence/hardware-mfa-YYYY-MM-DD.json`
  artifact validates and the operator confirms recovery paths without storing
  raw recovery codes in Git.

## Requested Roadmap Change

Move the hardware MFA bullet under `Auth, Secrets, And Capability Roadmap` from
generic remaining work to `Ready for proof`, or add a P0/mainnet sign-off row
with this close criterion:

`node scripts/ops/check-hardware-mfa-evidence.mjs --file docs/evidence/hardware-mfa-YYYY-MM-DD.json --json` returns `status: ok` for a sanitized operator evidence artifact covering 1Password admin, AWS root, AWS IAM admins, GitHub org admin, domain registrar, and OVH/VPS provider.
