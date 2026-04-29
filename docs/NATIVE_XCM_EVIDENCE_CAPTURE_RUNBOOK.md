# Native XCM Evidence Capture Runbook

Status: **operator runbook for Slice 10 evidence capture**. This is the
procedure for producing the three artifacts required before the native
Polkadot/Bifrost observer can become settlement truth for vDOT requests.

This runbook uses the tools described in the official Polkadot docs:

- Chopsticks replay/dry-run for tracing XCM execution on forked chains.
- PAPI for typed chain reads from Polkadot Hub and Bifrost.
- Fee and dry-run checks before treating a message shape as production-ready.

Source docs checked through the Polkadot docs MCP:

- `chain-interactions/send-transactions/interoperability/debug-and-preview-xcms.md`
- `chain-interactions/send-transactions/interoperability/estimate-xcm-fees.md`
- `smart-contracts/precompiles/xcm.md`

## Goal

Produce a validated evidence pack with:

1. one successful vDOT deposit
2. one successful vDOT withdrawal
3. one failed request with a stable `failureCode`

The pack must pass:

```bash
npm run check:native-xcm-evidence-pack -- \
  --deposit artifacts/xcm/native-deposit-evidence.json \
  --withdraw artifacts/xcm/native-withdraw-evidence.json \
  --failure artifacts/xcm/native-failure-evidence.json \
  --decision-output artifacts/xcm/native-evidence-decision.md
```

The generated decision record is the artifact reviewers use to decide whether
the production observer path is `request_id_in_message` or `remote_ref`.

## Preconditions

- `XcmWrapper.queueRequest` SetTopic validation is deployed in the target
  environment.
- Backend async XCM requests are generated from intent, not caller-supplied raw
  bytes.
- The request being captured uses the same `XcmVdotAdapter` and backend message
  builder that mainnet would use.
- Hub and Bifrost endpoints are pinned for the capture.
- The capture uses finalized blocks, or records the exact confirmation window
  used by the operator.

Do not use native observer output for automated settlement until this runbook
has produced a passing evidence pack.

## Artifact Layout

Use one directory per capture date or deployment:

```text
artifacts/xcm/2026-04-29-vdot-correlation/
  deposit/
    request.json
    hub.json
    bifrost.json
    evidence.json
  withdraw/
    request.json
    hub.json
    bifrost.json
    evidence.json
  failure/
    request.json
    hub.json
    bifrost.json
    evidence.json
  native-evidence-decision.md
```

The committed repo contains sample fixtures only. Real capture artifacts should
be stored in the operator artifact store unless Pascal explicitly asks to
commit a sanitized evidence pack.

## Capture Procedure

### 1. Queue The Request

Queue a real staging request through the normal backend path. Do not call
`XcmWrapper.queueRequest` directly unless the direct call is the thing being
tested.

Save the backend request payload:

```bash
curl -sS "https://api.averray.com/xcm/request?requestId=$REQUEST_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  > artifacts/xcm/2026-04-29-vdot-correlation/deposit/request.json
```

The request JSON must contain or be paired with:

- `requestId`
- direction: `deposit`, `withdraw`, or failure scenario direction
- expected asset/share amounts
- queued transaction or remote reference, if known

### 2. Capture Hub Evidence

Use PAPI, block explorers, or Chopsticks replay to capture the Hub-side
transaction and message evidence. The JSON must include:

```json
{
  "chain": "polkadot-hub",
  "blockNumber": "123",
  "blockHash": "0x...",
  "extrinsicHash": "0x...",
  "messageHash": "0x...",
  "messageTopic": "0x...",
  "eventIndex": "123-7"
}
```

For `request_id_in_message`, `messageTopic` must equal `requestId`.

If the Hub topic does not equal the request id, stop. That means the backend
assembler, `previewRequestId(context)` mirror, or wrapper validation path is not
the one we think it is.

### 3. Capture Bifrost Evidence

Capture the Bifrost-side terminal event or storage proof. The JSON must include:

```json
{
  "chain": "bifrost-polkadot",
  "blockNumber": "456",
  "blockHash": "0x...",
  "eventIndex": "456-12",
  "messageTopic": "0x...",
  "assetLocation": {
    "parents": 1,
    "interior": "Here"
  },
  "amount": "5000000000000"
}
```

If Bifrost preserves the original SetTopic on the reply leg, set
`messageTopic` to the observed topic and use `--method request_id_in_message`
with `--confidence production_candidate`.

If Bifrost does not preserve the topic, use `--method remote_ref` only if the
capture includes a durable remote reference that can be found again from chain
evidence without operator judgement.

Do not promote `ledger_join`. It is staging-only.

### 4. Assemble One Evidence Envelope

For a successful deposit:

```bash
npm run capture:native-xcm-evidence -- \
  --request-json artifacts/xcm/2026-04-29-vdot-correlation/deposit/request.json \
  --direction deposit \
  --status succeeded \
  --settled-assets 5000000000000 \
  --settled-shares 4900000000000 \
  --method request_id_in_message \
  --confidence production_candidate \
  --hub-json artifacts/xcm/2026-04-29-vdot-correlation/deposit/hub.json \
  --bifrost-json artifacts/xcm/2026-04-29-vdot-correlation/deposit/bifrost.json \
  --output artifacts/xcm/2026-04-29-vdot-correlation/deposit/evidence.json
```

For a successful withdrawal, use `--direction withdraw`.

For the failure capture, use `--status failed`, `--settled-assets 0`,
`--settled-shares 0`, and a stable `--failure-code 0x...`.

### 5. Validate Each Envelope

```bash
npm run validate:native-xcm-evidence -- \
  --file artifacts/xcm/2026-04-29-vdot-correlation/deposit/evidence.json
```

Repeat for withdraw and failure.

### 6. Validate The Pack

```bash
npm run check:native-xcm-evidence-pack -- \
  --deposit artifacts/xcm/2026-04-29-vdot-correlation/deposit/evidence.json \
  --withdraw artifacts/xcm/2026-04-29-vdot-correlation/withdraw/evidence.json \
  --failure artifacts/xcm/2026-04-29-vdot-correlation/failure/evidence.json \
  --decision-output artifacts/xcm/2026-04-29-vdot-correlation/native-evidence-decision.md
```

The pack passes only if:

- deposit is `direction=deposit`, `status=succeeded`
- withdrawal is `direction=withdraw`, `status=succeeded`
- failure is `status=failed` and has a `failureCode`
- every artifact is `production_candidate` or `production`
- all three artifacts use the same production correlation method
- no artifact uses `ledger_join`

## Decision Rules

### SetTopic Preserved

If all three captures pass with `method=request_id_in_message`, the native
observer may use:

```text
requestId == Hub messageTopic == Bifrost messageTopic
```

as the production-candidate correlation contract.

### SetTopic Not Preserved

If Hub has `messageTopic == requestId` but Bifrost does not preserve the topic,
try `remote_ref` only if the remote reference is deterministic and recoverable
from chain evidence.

If no durable `remoteRef` exists, do not implement live native reads yet. Choose
one of the documented fallbacks in [NATIVE_XCM_OBSERVER.md](./NATIVE_XCM_OBSERVER.md)
and add a new spec slice before production volume:

- serialized per-strategy dispatch, if Hub credit events are unambiguous
- amount perturbation, only as a last resort

## Failure Capture

The failure case should prove that a bad or underfunded request remains
correlatable. Prefer a controlled staging failure such as an intentionally
insufficient remote execution fee, invalid destination in a fork, or blocked
asset route.

The failure evidence must include a stable `failureCode`. The code can be a
hash of the observed chain error if the runtime does not expose a compact enum,
but the mapping must be documented before live reads are enabled.

## Promotion Checklist

- [ ] Deposit evidence validates.
- [ ] Withdrawal evidence validates.
- [ ] Failure evidence validates.
- [ ] Pack gate validates.
- [ ] Decision record generated.
- [ ] Decision record reviewed against [NATIVE_XCM_OBSERVER.md](./NATIVE_XCM_OBSERVER.md).
- [ ] If `remote_ref` was selected, fallback rationale is documented before
      native live reads are enabled.
- [ ] Operator artifact store contains raw Hub/Bifrost captures and assembled
      evidence envelopes.

## What This Does Not Do

- It does not implement live PAPI reads.
- It does not enable native observer settlement.
- It does not prove Hydration GDOT, multi-hop XCM, or money-market borrow flows.
- It does not replace the internal staging observe/finalize path until the pack
  passes and the operator explicitly promotes the observer source.
