# Native XCM Observer Design

Status: **correlation gate scaffold shipped; empirical replay pending**. This is the implementation plan for replacing
paid/third-party XCM shortcuts with an Averray-operated observer that
publishes terminal outcomes into the existing `/xcm/outcomes` feed.

This doc sits after:

- [ASYNC_XCM_STAGING.md](./ASYNC_XCM_STAGING.md)
- [NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md](./NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md)
- [POLKADOT_EXECUTION_PLAN.md](./POLKADOT_EXECUTION_PLAN.md)
- [strategies/vdot.md](./strategies/vdot.md)

The goal is narrow:

> Observe enough native Polkadot/Bifrost evidence to decide whether one
> queued Averray XCM request succeeded, failed, or was cancelled, then
> publish that terminal result in the feed shape the backend already
> consumes.

---

## Official-doc constraints

The official Polkadot docs imply four design constraints:

1. **XCM from contracts is intentionally low-level.**
   The Polkadot Hub XCM precompile lives at
   `0x00000000000000000000000000000000000a0000` and exposes `execute`,
   `send`, and `weighMessage`. Messages are SCALE-encoded, and the docs
   explicitly describe the precompile as barebones. Our wrapper boundary
   is therefore still the right shape.

2. **PAPI is the right native-read tool.**
   Polkadot-API provides typed access to storage, constants, transactions,
   events, and runtime APIs, with generated types from on-chain metadata.
   A native observer should use PAPI descriptors for the chains it watches
   rather than ad hoc JSON-RPC parsing.

3. **Asset identity must stay explicit.**
   Polkadot Hub supports native and foreign assets, and foreign assets are
   identified by XCM multilocation. The observer cannot assume that one
   EVM token address is enough to understand what settled.

4. **Replay/dry-run is part of the validation loop.**
   Official docs recommend Chopsticks replay and dry-run workflows for
   diagnosing XCM failures, tracing cross-chain message flow, inspecting
   emitted events, and validating behavior before production use.

Source docs used through the Polkadot docs MCP:

- `smart-contracts/precompiles/xcm.md`
- `reference/tools/papi.md`
- `reference/polkadot-hub/assets.md`
- `chain-interactions/send-transactions/interoperability/debug-and-preview-xcms.md`

---

## Current architecture to preserve

The repo already has a clean producer/consumer contract:

```text
native or external observer
  -> indexer XcmOutcomePublisherService
  -> durable xcm_external_outcomes table
  -> GET /xcm/outcomes
  -> backend XcmObservationRelayService
  -> PlatformService.observeXcmOutcome(...)
  -> XcmSettlementWatcher
  -> AgentAccountCore.settleStrategyRequest(...)
```

That means the native observer should be an **upstream source adapter**,
not a new backend settlement path.

Primary files:

- [indexer/src/api/xcm-upstream-source.ts](../indexer/src/api/xcm-upstream-source.ts)
- [indexer/src/api/xcm-outcome-publisher.ts](../indexer/src/api/xcm-outcome-publisher.ts)
- [indexer/src/api/xcm-outcomes.ts](../indexer/src/api/xcm-outcomes.ts)
- [mcp-server/src/services/xcm-observation-relay.js](../mcp-server/src/services/xcm-observation-relay.js)
- [mcp-server/src/services/xcm-settlement-watcher.js](../mcp-server/src/services/xcm-settlement-watcher.js)

The existing published outcome shape remains the contract:

```json
{
  "requestId": "0x...",
  "status": "succeeded",
  "settledAssets": "5",
  "settledShares": "5",
  "remoteRef": "0x...",
  "failureCode": null,
  "observedAt": "2026-04-23T12:00:00.000Z",
  "source": "native_papi_observer"
}
```

---

## Correlation gate

The first native-observer milestone is **not** writing a watcher loop. It is
proving deterministic correlation.

Today `XcmWrapper` emits:

- `RequestQueued(requestId, strategyId, kind, account, asset, recipient, assets, shares, nonce)`
- `RequestPayloadStored(requestId, destinationHash, messageHash, refTime, proofSize)`
- `RequestStatusUpdated(...)`

That is enough for the internal async lane and indexer fallback. It is not
yet enough to prove that an arbitrary Bifrost/Hub event belongs to one
Averray request unless the dispatched XCM or downstream action carries a
stable correlation handle.

Before implementation, choose and validate one correlation contract:

1. **Request-id-in-message path**
   Include `requestId` as the trailing XCM `SetTopic(requestId)` instruction.
   The Hub-side message topic must equal the Averray request id. To promote this
   path beyond staging, Bifrost reply-leg evidence must also preserve the same
   topic.

2. **Remote-ref path**
   Derive a deterministic `remoteRef` from the outbound Hub transaction,
   message hash, destination, and downstream chain evidence, then store it
   on settlement.

3. **Ledger-join path**
   Join the local `requestId` to a narrow set of observed source/destination
   events using block range, account, asset, amount, strategy, and message
   hash. This is weaker and should be treated as staging-only unless it can
   be made collision-resistant.

Ship gate:

- one queued deposit and one queued withdrawal can be matched to native
  chain evidence without operator judgement
- the match survives retry/idempotency behavior
- duplicate observations collapse to one terminal outcome
- `request_id_in_message` evidence marked `production_candidate` or
  `production` includes matching Hub and Bifrost `messageTopic == requestId`
- `ledger_join` evidence remains `staging` only and is rejected for
  production-candidate use

---

## Proposed source adapter

The repo now reserves a source type behind the existing publisher:

```text
XCM_EXTERNAL_SOURCE_TYPE=native_papi
XCM_NATIVE_HUB_WS=wss://...
XCM_NATIVE_BIFROST_WS=wss://...
XCM_NATIVE_START_BLOCK=...
XCM_NATIVE_CONFIRMATIONS=...
```

Suggested implementation:

- `NativePapiXcmSourceAdapter` in
  [indexer/src/api/xcm-upstream-source.ts](../indexer/src/api/xcm-upstream-source.ts)
- a small helper module if the adapter grows too large, for example
  `indexer/src/api/native-papi-xcm-source.ts`

Current implementation status:

- env validation and status reporting exist
- cursor encode/decode helpers exist
- evidence-to-`PublishedOutcome` normalization exists
- captured evidence is now correlation-gated: SetTopic/request-id evidence,
  remote-ref evidence, and staging-only ledger joins are validated differently
- live PAPI reads intentionally fail until the correlation gate is proven

Adapter responsibilities:

1. Maintain a durable cursor per watched chain.
2. Read Hub-side wrapper request context from the indexed Ponder tables or
   from chain events.
3. Subscribe or page through Hub and Bifrost finalized blocks.
4. Extract only events/calls relevant to configured strategy assets and
   accounts.
5. Match evidence to an Averray `requestId`.
6. Emit only terminal outcomes: `succeeded`, `failed`, or `cancelled`.
7. Preserve a `remoteRef` that lets an operator find the source evidence
   again.

The adapter should not call `AgentAccountCore` or the backend directly.
It only publishes outcomes. The backend relay and watcher already own
settlement.

---

## Event evidence model

For each matched request, capture an evidence envelope internally even if
the public `/xcm/outcomes` item stays compact:

```json
{
  "requestId": "0x...",
  "direction": "deposit",
  "hub": {
    "blockNumber": "123",
    "blockHash": "0x...",
    "extrinsicHash": "0x...",
    "messageHash": "0x..."
  },
  "bifrost": {
    "blockNumber": "456",
    "blockHash": "0x...",
    "eventIndex": "456-12",
    "assetLocation": "{...}",
    "amount": "5"
  },
  "decision": {
    "status": "succeeded",
    "settledAssets": "5",
    "settledShares": "5",
    "reason": "matched_terminal_bifrost_event"
  }
}
```

The public feed can keep returning `PublishedOutcome`, but the durable
database should retain enough evidence for audit and dispute debugging.

---

## Validation plan

### 1. Offline replay

- capture one real or staging XCM request
- fork the relevant chains with Chopsticks
- replay the Hub-side transaction
- inspect emitted events and message flow
- write down the exact event fields needed for correlation
- save the captured evidence as `native-xcm-observer-evidence-v1`
  JSON and validate it locally

### 2. Dry-run before production

- dry-run the relevant XCM call/message against forked state
- verify the failure mode is observable when weights, fees, destination,
  or asset identity are wrong

### 3. Staging adapter

- run `native_papi` against staging endpoints only
- compare its decisions with the internal manual observe path from
  [ASYNC_XCM_STAGING.md](./ASYNC_XCM_STAGING.md)
- require the two paths to agree for deposit success, withdrawal success,
  and one failure case

### 4. Promotion gate

Native observer output is acceptable for automated settlement only after:

- request correlation is deterministic
- cursors survive restarts
- reorg/finality assumptions are documented
- duplicate terminal observations are idempotent
- failure evidence maps to stable `failureCode` values
- captured reports exist for success, delay, and failure

### Evidence validator

The repo includes a sample evidence envelope:

- [docs/fixtures/xcm/native-observer-evidence.sample.json](./fixtures/xcm/native-observer-evidence.sample.json)
- [docs/fixtures/xcm/native-observer-evidence-withdraw.sample.json](./fixtures/xcm/native-observer-evidence-withdraw.sample.json)
- [docs/fixtures/xcm/native-observer-evidence-failure.sample.json](./fixtures/xcm/native-observer-evidence-failure.sample.json)
- [docs/fixtures/xcm/native-hub-event.sample.json](./fixtures/xcm/native-hub-event.sample.json)
- [docs/fixtures/xcm/native-bifrost-event.sample.json](./fixtures/xcm/native-bifrost-event.sample.json)

After a Chopsticks/PAPI replay, assemble the envelope from captured Hub and
Bifrost artifacts:

```bash
npm run capture:native-xcm-evidence -- \
  --request-id 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --direction deposit \
  --status succeeded \
  --settled-assets 5000000000000 \
  --settled-shares 4900000000000 \
  --method request_id_in_message \
  --confidence production_candidate \
  --hub-topic 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --bifrost-topic 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --hub-json docs/fixtures/xcm/native-hub-event.sample.json \
  --bifrost-json docs/fixtures/xcm/native-bifrost-event.sample.json \
  --output artifacts/xcm/native-observer-evidence.json
```

Validate a captured envelope with:

```bash
npm run validate:native-xcm-evidence -- \
  --file artifacts/xcm/native-observer-evidence.json
```

The validator checks:

- schema version
- request id, remote ref, hashes, and failure code shapes
- terminal status
- settled asset/share amounts
- Hub and Bifrost evidence blocks
- correlation method and confidence level
- for `request_id_in_message`, Hub `messageTopic` must equal `requestId`; for
  `production_candidate`/`production`, Bifrost `messageTopic` must also equal
  `requestId`
- for `remote_ref`, a `remoteRef` is required
- for `ledger_join`, confidence must remain `staging`
- consistency between top-level outcome and decision payload

This is intentionally stricter than the public `/xcm/outcomes` item. The
compact feed is for automated settlement; the evidence envelope is for
debugging, audit, and proving the native observer is not guessing.

### Evidence pack gate

Before the native observer can become settlement truth, collect three separate
captures:

1. successful vDOT deposit
2. successful vDOT withdrawal
3. one failed request with a stable `failureCode`

Validate the whole pack:

```bash
npm run check:native-xcm-evidence-pack -- \
  --deposit artifacts/xcm/native-deposit-evidence.json \
  --withdraw artifacts/xcm/native-withdraw-evidence.json \
  --failure artifacts/xcm/native-failure-evidence.json \
  --decision-output artifacts/xcm/native-evidence-decision.md
```

The pack checker runs the single-envelope validator for each file, then applies
the launch gate across all three captures:

- deposit must be `direction=deposit` and `status=succeeded`
- withdraw must be `direction=withdraw` and `status=succeeded`
- failure must be `status=failed` and include a `failureCode`
- every capture must be `production_candidate` or `production`
- all captures must use the same production correlation method
- `ledger_join` is rejected because it is staging-only

If all three use `request_id_in_message`, the pack supports the SetTopic
preservation path. If they all use `remote_ref`, the pack supports the fallback
path and the fallback must be documented here before live reads are enabled.
The optional `--decision-output` file is the review artifact for that decision.

---

## Open implementation questions

1. What exact Bifrost events or storage reads prove vDOT mint/redeem
   settlement for our chosen XCM message shape?
2. Can the request id be carried through the downstream operation, or do
   we need a derived `remoteRef`?
3. Which chain should be the source of truth for each direction:
   Hub, Bifrost, or a two-chain join?
4. What confirmation/finality window should the observer require before
   publishing a terminal outcome?
5. Do we need to persist raw evidence JSON next to
   `xcm_external_outcomes`, or is a separate audit-artifact capture enough
   for the first staging pass?

---

## Recommended next implementation slice

1. Follow
   [NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md](./NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md)
   to capture one real staging evidence pack with Chopsticks/PAPI.
2. If Bifrost does not preserve SetTopic on the reply leg, document the chosen
   fallback (`remote_ref`, serialized dispatch, or amount perturbation) before
   implementing live reads.
3. Only then wire live PAPI reads.

This keeps the next change reviewable and avoids turning the observer into
an untestable network script.
