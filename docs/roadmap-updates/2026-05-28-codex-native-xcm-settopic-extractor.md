# Roadmap Update: Native XCM SetTopic proof prep

- **Date:** 2026-05-28
- **Agent:** Codex / `codex/native-xcm-settopic-proof-prep`
- **Roadmap section:** Native XCM, vDOT, And Yield Roadmap
- **Item:** Chopsticks Bifrost SetTopic proof / External observer validation
- **Related PRs/issues:** current PR
- **Proposed status:** Open
- **Owner:** Native XCM operator / roadmap steward

## Summary

This slice hardens the native XCM event extractor so SetTopic proof cannot be
fabricated from arbitrary request-id text in decoded event JSON. Captured Hub or
Bifrost evidence must now include an explicit topic-like field before the
extractor emits `messageTopic`; missing-topic captures are only allowed for the
`remote_ref` fallback investigation path.

## Evidence

- Polkadot docs MCP check:
  `chain-interactions/send-transactions/interoperability/debug-and-preview-xcms.md`
  documents Chopsticks replay/dry-run as the supported way to capture and debug
  local XCM behavior.
- Polkadot docs MCP check:
  `smart-contracts/precompiles/xcm.md` documents the Hub XCM precompile
  `send`/`weighMessage` flow and SCALE-encoded XCM messages.
- Tests: `node --test scripts/ops/extract-native-xcm-event.test.mjs`

## Blockers Or Caveats

- This does not produce real Chopsticks/PAPI evidence.
- The roadmap rows remain `Open` until deposit, withdraw, and failure captures
  are collected and validated by `check-native-xcm-evidence-pack.mjs`.

## Requested Roadmap Change

Keep the Native XCM rows `Open`. After this PR merges, note that the SetTopic
capture extractor now requires explicit topic/message-id fields, reducing the
risk that a false-positive decoded event advances the native observer gate.
