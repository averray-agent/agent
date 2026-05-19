# Roadmap Update: Alert destination

- **Date:** 2026-05-19
- **Agent:** codex/alert-wrapper-proof
- **Roadmap section:** Open Work To RC1/Testnet Launch / P0 Launch Gates
- **Item:** Alert destination
- **Related PRs/issues:** pending PR for this branch
- **Proposed status:** Ready for proof
- **Owner:** Operator / roadmap steward after merge

## Summary

The hosted-stack alert wrapper already existed, and this branch adds regression
coverage proving it sends a structured webhook payload when the hosted smoke
check fails. This makes the P0 item implementation-ready, but not yet Proofed:
an operator still needs to configure the real production alert destination and
run one deliberate hosted smoke failure to prove delivery.

## Evidence

- `scripts/ops/check-hosted-stack-and-alert.test.mjs` covers:
  - passing smoke exits without alerting;
  - failing smoke without `ALERT_WEBHOOK_URL` fails closed;
  - failing smoke with a webhook sends JSON containing service, environment,
    timestamp, check name, summary, and captured output.
- The wrapper now supports `CHECK_HOSTED_STACK_SCRIPT` so tests can inject a
  deterministic smoke-check stub without touching production URLs.

## Blockers Or Caveats

- Production `ALERT_WEBHOOK_URL` still needs to be configured in the scheduler
  environment that runs `scripts/ops/check-hosted-stack-and-alert.sh`.
- A deliberate hosted smoke failure must be sent to the real operator channel
  before the roadmap item can move from `Ready for proof` to `Proofed`.

## Requested Roadmap Change

After this branch merges, update the P0 launch gate row:

```md
| Alert destination | Ready for proof | Alert wrapper is tested for structured webhook delivery on smoke failure. Close after `ALERT_WEBHOOK_URL` is configured in the production scheduler environment and one deliberate hosted smoke failure reaches the operator channel. |
```
