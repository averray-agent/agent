# Roadmap Update: Native XCM evidence pack gate coverage

- **Date:** 2026-05-24
- **Agent:** Codex / `codex/native-xcm-pack-tests`
- **Roadmap section:** Native XCM, vDOT, And Yield Roadmap
- **Item:** Chopsticks Bifrost SetTopic proof / External observer validation
- **Related PRs/issues:** [PR #503](https://github.com/averray-agent/agent/pull/503)
- **Proposed status:** Open
- **Owner:** Native XCM operator / roadmap steward

## Summary

This slice adds focused CLI regression coverage for the three-artifact native
XCM evidence pack gate. It does not produce real Chopsticks/PAPI evidence and
does not advance the Native XCM roadmap rows; it hardens the tooling that will
judge deposit, withdraw, and failure captures once the operator has real Hub
and Bifrost observations.

## Evidence

- New test file:
  `scripts/ops/check-native-xcm-evidence-pack.test.mjs`.
- Coverage includes production-candidate SetTopic/request-id acceptance,
  decision-record output, mixed-correlation rejection, staging-only
  `ledger_join` rejection, staging-confidence rejection, and wrong-slot
  direction rejection.

## Blockers Or Caveats

- Real native XCM capture evidence is still required. Fixture-based tests only
  protect the local gate semantics.
- No Polkadot runtime state or transaction proof is included in this PR.

## Requested Roadmap Change

Keep the Native XCM rows `Open`. When real deposit, withdraw, and failure
captures exist, validate them with
`npm run check:native-xcm-evidence-pack -- --deposit ... --withdraw ... --failure ...`
and attach the generated decision record before moving any row.
