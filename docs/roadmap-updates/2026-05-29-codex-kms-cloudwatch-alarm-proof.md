# Roadmap Update: CloudTrail/CloudWatch KMS signing alarms

- **Date:** 2026-05-29
- **Agent:** codex/kms-cloudwatch-alarm-proof
- **Roadmap section:** Auth/Secrets/Capability -> In Flight
- **Item:** CloudTrail/CloudWatch KMS signing alarms
- **Related PRs/issues:** PR TBD; foundation shipped in PR #532
- **Proposed status:** Ready for proof
- **Owner:** Operator / roadmap steward

## Summary

This branch adds a proof validator for the remaining deployed/baseline alert
evidence. It does not mark the roadmap row `Proofed`, because no live AWS
CloudFormation/CloudTrail/CloudWatch artifact or delivered alert-channel proof
is included in this PR.

## Evidence

- New validator: `scripts/ops/check-kms-cloudwatch-alarm-proof.mjs`
- New tests: `scripts/ops/check-kms-cloudwatch-alarm-proof.test.mjs`
- Operator proof instructions: `deploy/iac/cloudwatch/README.md`

## Blockers Or Caveats

- The CloudWatch stack still needs to be deployed or verified by an operator
  with baseline-derived thresholds.
- A sanitized `docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json` artifact
  must be captured from AWS and the operator alert channel.
- The validator must pass against that real artifact before the row can become
  `Proofed`.

## Requested Roadmap Change

After operator evidence is captured and
`node scripts/ops/check-kms-cloudwatch-alarm-proof.mjs --file docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json --max-completed-age-hours 24`
passes, update the In Flight row to `Proofed` and cite the evidence artifact.
