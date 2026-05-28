# Roadmap Update: Native XCM capture preflight coverage

- **Date:** 2026-05-28
- **Agent:** Codex / `codex/native-xcm-preflight-coverage`
- **Roadmap section:** Native XCM, vDOT, And Yield Roadmap
- **Item:** Chopsticks Bifrost SetTopic proof / External observer validation
- **Related PRs/issues:** current PR
- **Proposed status:** Open
- **Owner:** Native XCM operator / roadmap steward

## Summary

This slice adds focused regression coverage around the native XCM capture
preflight. The preflight now has tests proving it accepts a capture-ready vDOT
strategy config, fails closed without a `polkadot_vdot` strategy, surfaces
malformed destination config, and reports missing live capture environment
variables before operators attempt a Chopsticks/PAPI capture.

## Evidence

- Polkadot docs MCP check:
  `chain-interactions/send-transactions/interoperability/debug-and-preview-xcms.md`
  identifies Chopsticks replay/dry-run as the local XCM debugging workflow.
- Polkadot docs MCP check:
  `smart-contracts/precompiles/xcm.md` documents the Hub XCM precompile
  `send`/`weighMessage` interface and SCALE-encoded XCM requirement.
- Tests: `node --test scripts/ops/preflight-native-xcm-capture.test.mjs`

## Blockers Or Caveats

- This does not produce real Chopsticks/PAPI evidence.
- Native XCM roadmap rows remain `Open` until real deposit, withdraw, and
  failure captures are collected and validated by the evidence-pack gate.

## Requested Roadmap Change

Keep the Native XCM rows `Open`. After this PR merges, note that the native
capture preflight has direct tests for strategy readiness and strict live-env
checks, reducing the chance operators start a real capture from a stale or
scaffolded config.
