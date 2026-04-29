# Async XCM Staging Runbook

This is the current-lane operator proof for the async Polkadot treasury
flow without depending on a paid external observer like Subscan.

Use it when we want to prove:

- a wallet can queue an async treasury request
- operators can inspect that request
- the hosted stack can ingest an observed result
- the watcher can auto-finalize the request
- the request reaches a terminal state cleanly

It complements:

- [POLKADOT_EXECUTION_PLAN.md](./POLKADOT_EXECUTION_PLAN.md)
- [strategies/vdot.md](./strategies/vdot.md)
- [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)

---

## 1. Preconditions

- The target deployment has an async strategy configured with
  `executionMode: "async_xcm"`.
- The backend has `XCM_WRAPPER_ADDRESS` configured.
- The settlement watcher is enabled.
- You have:
  - one wallet JWT for the user request path
  - one admin JWT for the operator path

For a fresh Polkadot Hub TestNet/staging contract suite, the deploy script can
produce the right manifest shape with:

```bash
WITH_XCM_WRAPPER=1 WITH_XCM_VDOT_ADAPTER=1 ./scripts/deploy_contracts.sh
```

Use `PROFILE=testnet` plus the normal private deploy env. The manifest then
provides:

- `contracts.xcmWrapper` -> backend `XCM_WRAPPER_ADDRESS`
- `strategies` -> backend `STRATEGIES_JSON`

The async vDOT deploy path is blocked for `PROFILE=mainnet` until the native
XCM evidence pack passes.

Useful health check:

```bash
curl -sS https://api.averray.com/admin/status \
  -H "authorization: Bearer $ADMIN_JWT"
```

The response should show `xcmSettlementWatcher.enabled == true`.

---

## 2. Create A Request

Queue an async treasury deposit from a wallet-scoped session.

```bash
curl -sS https://api.averray.com/account/allocate \
  -H "authorization: Bearer $WALLET_JWT" \
  -H "content-type: application/json" \
  -d '{
    "strategyId": "your-async-strategy-id",
    "amount": 5,
    "idempotencyKey": "staging-async-deposit-001"
  }'
```

Expected result:

- the response includes `requestId`
- `xcmRequest.statusLabel` is `pending`
- `/account/strategies` shows `pendingDepositAssets > 0`

You can also queue an async withdrawal:

```bash
curl -sS https://api.averray.com/account/deallocate \
  -H "authorization: Bearer $WALLET_JWT" \
  -H "content-type: application/json" \
  -d '{
    "strategyId": "your-async-strategy-id",
    "amount": 5,
    "idempotencyKey": "staging-async-withdraw-001"
  }'
```

---

## 3. Inspect The Request

Use the returned `requestId`.

```bash
curl -sS "https://api.averray.com/xcm/request?requestId=$REQUEST_ID" \
  -H "authorization: Bearer $ADMIN_JWT"
```

Expected fields:

- `requestId`
- `kindLabel` = `deposit` or `withdraw`
- `statusLabel` = `pending`
- `requestedAssets` or `requestedShares`

---

## 4. Exercise The Operator Path

Preferred path: simulate an observed outcome and let the watcher
auto-finalize it.

```bash
API_URL=https://api.averray.com \
ADMIN_JWT="$ADMIN_JWT" \
REQUEST_ID="$REQUEST_ID" \
XCM_CAPTURE_PATH=artifacts/xcm/internal-async-xcm-report.json \
node scripts/ops/exercise-async-xcm-request.mjs \
  --mode observe \
  --status succeeded \
  --settled-assets 5 \
  --settled-shares 5
```

Manual-finalize fallback:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT="$ADMIN_JWT" \
REQUEST_ID="$REQUEST_ID" \
node scripts/ops/exercise-async-xcm-request.mjs \
  --mode finalize \
  --status succeeded \
  --settled-assets 5 \
  --settled-shares 5
```

Failure-path rehearsal:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT="$ADMIN_JWT" \
REQUEST_ID="$REQUEST_ID" \
node scripts/ops/exercise-async-xcm-request.mjs \
  --mode observe \
  --status failed \
  --failure-code 0x6661696c757265000000000000000000000000000000000000000000000000
```

What the helper script does:

- reads `/xcm/request` before mutation
- posts to `/admin/xcm/observe` or `/admin/xcm/finalize`
- polls `/xcm/request` until terminal when using `observe`
- optionally writes a JSON report to disk

---

## 5. Verify The Result

After a successful deposit:

- `/xcm/request` reaches `statusLabel = "succeeded"`
- `/account/strategies` no longer shows pending deposit for that request
- the routed lane shows updated `shares` / `routedAmount`

After a failed deposit:

- `/xcm/request` reaches `statusLabel = "failed"`
- pending deposit posture clears
- local liquid funds remain available again

After a successful withdrawal:

- `/xcm/request` reaches `statusLabel = "succeeded"`
- pending withdrawal posture clears
- liquid assets increase if the recipient is the agent account

Also check:

```bash
curl -sS https://api.averray.com/admin/status \
  -H "authorization: Bearer $ADMIN_JWT"
```

Expected:

- `xcmSettlementWatcher.pendingCount == 0` after the flow settles
- no unexpected `xcmObservationRelay.lastError` if the relay is enabled

---

## 6. What Counts As Passing

- One deposit request reaches terminal status cleanly.
- One withdraw request reaches terminal status cleanly.
- One failure-path rehearsal behaves honestly.
- The watcher clears its pending queue after observation.
- The resulting report is saved as evidence for the current deployment.

This is the current-lane proof we can run before paying for Subscan or
before building the native Polkadot/Bifrost observer.

For the next native-observer lane, see
[NATIVE_XCM_OBSERVER.md](./NATIVE_XCM_OBSERVER.md) and the operator
[NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md](./NATIVE_XCM_EVIDENCE_CAPTURE_RUNBOOK.md).
That design keeps the existing `/xcm/outcomes` producer contract and focuses
first on proving a deterministic correlation path from an Averray `requestId`
to native Hub/Bifrost settlement evidence.

The native evidence validator now enforces the correlation gate:

- `request_id_in_message` requires Hub evidence with `messageTopic == requestId`.
- `request_id_in_message` promoted to `production_candidate` additionally
  requires Bifrost reply-leg evidence with `messageTopic == requestId`.
- `remote_ref` requires a durable `remoteRef`.
- `ledger_join` is staging-only and cannot be promoted.

Until a real Chopsticks/PAPI capture passes those rules, use the internal
observe/finalize path above for staging settlement.

Once deposit, withdraw, and failure captures exist, validate the three-artifact
gate before promoting the native observer:

```bash
npm run check:native-xcm-evidence-pack -- \
  --deposit artifacts/xcm/native-deposit-evidence.json \
  --withdraw artifacts/xcm/native-withdraw-evidence.json \
  --failure artifacts/xcm/native-failure-evidence.json \
  --decision-output artifacts/xcm/native-evidence-decision.md
```

The pack gate rejects staging-only `ledger_join` evidence and requires a single
production-candidate correlation method across all three captures. The
decision output records whether the pack supports SetTopic/request-id
correlation or the `remote_ref` fallback.
