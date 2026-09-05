# PACKET — The dispatch script hardcodes the LEGACY strategy id into every request-id

Status: **READY FOR CODEX — blocks the first v2.1 yield cycle** · 2026-09-05 ·
Author: Claude (architect+gate) · Repo: **platform** · One PR. **No contracts.
No funds. Nothing on-chain is wrong.**

## What happened

Deployment 1 on v2.1 (9.980137 USDC, return-by 2026-09-12T08:38Z) was created
cleanly. The **dispatch** dry run — `stage-dispatch` — then refused:

```
stagedFundingDryRun: failed — module {index: 90, error: 0x1a}   (revive.ContractReverted)
stageDiagnostic: eth_call_success
```

## Root cause — PROVEN by read-only replay, not inferred

`pool-venue-dispatch.mjs:97`:
```js
const EXPECTED_STRATEGY_ID = "0x4859…5631…";   // = HYDRATION_USDC_POOL_V1, the LEGACY lane
```
is baked into the request-id keccak in **both** derivations:
```js
:377  deriveLaneRequestId        [EXPECTED_STRATEGY_ID, 0, venue, asset, venue, assets, 0, nonce]
:384  deriveLaneRecallRequestId  [EXPECTED_STRATEGY_ID, 1, venue, asset, venue, 0, shares, nonce]
```
The v2.1 lane's strategy is `AAC_IDLE_HYDRATION_V1`. So the script predicts
`0x092f6d62…` while the chain's real id is **`0xe9860ce6…bdc239e0`** (read from
the lane's `DepositRequested`, the wrapper's queue event, and the adapter's
`LaneRequestStaged` in a stage-only dry run). The stateful stage+fund simulation
then calls `dispatchLeg` on a request that does not exist → `UnknownRequest()`
→ `ContractReverted`.

**Proof:** replaying `stage + dispatchLeg(REAL id, DepositFunding)` through
`dryRunApi.dryRunCall` **succeeds** — `Ok`, 30 events, `polkadotXcm.Sent`,
`xcmpQueue.XcmpMessageSent`, one XCM forwarded to Parachain 2034 (Hydration),
`utility.BatchCompleted`. **The funding leg for the new pair works end to end.**
Amounts reconcile exactly (transferred 9,980,137 = `requestedAssets` =
`context.assets`), ruling out `CustodyMismatch` and the lane's amount check.

Everything else was eliminated by direct comparison against the legacy pair:
policy settler gates (identical), lane postage (0.01 DOT each), allowances (0
each), shared `hydrationAccountId32`, both strategies registered. The **only**
difference is this constant.

## Blast radius — all six sites

| line | use | effect on v2.1 |
|---|---|---|
| `:377` | deposit request-id | wrong prediction → dry run cannot pass |
| `:384` | recall request-id | same, for every future v2.1 recall |
| `:1152` | wrapper-record identity guard | will refuse v2.1 records as "not our lane" |
| `:1442` | **recall RESUME guard** | a stuck v2.1 recall could not be resumed — the exact 2026-09-01 scenario, un-recoverable |
| `:1617` | staged-wrapper-record guard | same class |

The **commit** path reads the real id from the `LaneRequestStaged` receipt, so
a commit would likely work — and the script correctly refuses to commit on a
failed dry run. Do **not** bypass that; fix the prediction.

`pool-venue-ceremony.mjs` has zero occurrences — this is dispatch-only. It is the
same defect family as #1339 (pool-blind global), one layer down.

## The fix

**A — Resolve the strategy id per pool, from the chain.** The lane exposes
`bytes32 public immutable strategyId` (`HydrationUsdcAdapterV22.sol:18`). Once
the pool's adapter and lane are resolved (#1339 already does this), read
`lane.strategyId()` and use it in all six sites. The manifest may additionally
record it per lane for cross-checking, but the chain value is authoritative.

**B — Stop predicting in the dry run; read the id from the stage's own events.**
Run the stage alone through `dryRunApi`, decode `LaneRequestStaged` from
`emittedEvents`, and use *that* id for the funding-leg simulation — exactly what
the commit path already does with the real receipt. This removes an entire
class of prediction bugs and mirrors the proof above.

Keep A even with B: the guards at `:1152/:1442/:1617` compare recorded ids and
need the per-pool value regardless.

## Non-negotiables (each pinned by a test)

1. **Mutation:** a v2.1 dispatch dry run with the legacy constant fails; with
   the per-pool strategy id it reaches the funding-leg simulation.
2. A legacy dispatch dry run is byte-identical in behaviour to today.
3. The recall-resume guard (`:1442`) accepts a v2.1 staged record and still
   rejects a record bound to a *different* pool's lane.
4. The dry-run funding simulation uses the id emitted by the staged events, not
   a local prediction — prove by making the predictor return garbage and
   asserting the simulation still targets the emitted id.
5. No constant named after a single strategy remains as a correctness input;
   `EXPECTED_STRATEGY_ID` may survive only as the *legacy* manifest fallback,
   never as a default.

## Live state while this is open — safe

v2.1 deployment 1 is pending with 9.980137 at the **new adapter** (our
contract), nothing left Hub, `returnBy` margin ≈ 6.9 days. The `cancel` path
exists if the fix does not land in time.

## Handback

PR number; green CI; the five test names; the v2.1 `stage-dispatch` dry run
reaching `stagedFundingDryRun: success` with the emitted request id
`0xe9860ce6…bdc239e0`; and the legacy dry run unchanged.
