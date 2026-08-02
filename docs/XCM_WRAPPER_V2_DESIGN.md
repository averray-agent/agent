# XcmWrapper v2 — Hydration USDC two-phase custody design

Status: **design gate; no implementation or deployment**.

This is the contract decision required by `BANK_PHASE1_BUILD_PACKET.md` gate 4.
It closes the four activation blockers recorded in
`BANK_PHASE1_OBSERVER_DESIGN.md` while preserving the request lifecycle consumed
by the observer merged in PR #910.

The scope is treasury-owned USDC on the proven Polkadot Asset Hub → Hydration
Aave route. It is not a generic raw-XCM executor. Agent balances, other venues,
borrowing, leverage, and deployment are out of scope.

## Invariants

1. One request retains the existing deterministic `requestId`, `Pending` record,
   and terminal `finalizeRequest` transition.
2. `queueRequest(RequestContext,bytes,bytes,Weight)` and
   `finalizeRequest(bytes32,RequestStatus,uint256,uint256,bytes32,bytes32)` keep
   their selectors and meanings. PR #910's observer and settlement sink do not
   need a new request model.
3. Every signed leg has already passed the exact-message DryRunApi guard in
   `BankXcmFlowCoordinator`. Solidity then independently decodes the bytes and
   accepts only one of the four shapes in this document.
4. The wrapper is the Asset Hub XCM origin for every leg. The local funding leg
   is executed by the wrapper; remote legs are sent by the wrapper. No EOA fronts
   capital or acts from a second remote identity.
5. Deposit capital moves AAC → adapter → wrapper → XCM. The wrapper pulls the
   adapter's recorded allocation in the same transaction that executes the
   funding message. If local XCM execution reverts, the pull reverts too.
6. `_validateSettlementBounds` is retained byte-for-byte. Destination-state
   balance deltas remain settlement truth; XCM completion alone is never enough.

## Contract boundary

### Stable public lifecycle

The interface in `IXcmWrapper` remains stable. A request now has two dispatch
legs behind the existing `queueRequest` selector:

| Request kind | First `queueRequest` leg | Readiness evidence | Second `queueRequest` leg | Terminal evidence |
|---|---|---|---|---|
| Deposit | `DepositFunding`: local `execute` of the reserve-transfer funding message | converted-account asset-22 increase | `DepositSell`: `send` the 22 → 1003 `Transact` message | converted-account aUSDC ERC-20 increase |
| Withdraw | `WithdrawSell`: `send` the 1003 → 22 `Transact` message | aUSDC decrease and asset-22 increase | `WithdrawHome`: `send` the reserve-withdraw-home message | wrapper Asset Hub USDC increase |

Both calls derive the same `requestId` from the unchanged `RequestContext`.
The first creates the `Pending` `RequestRecord`; the second advances its dispatch
phase without creating another request. An exact retry of a completed leg is a
no-op returning the same id. A different payload for an already-recorded leg,
an out-of-order leg, a third leg, or a leg after terminal finalization reverts.

New sidecar storage records the associated adapter, a two-bit dispatched-leg
bitmap, and destination/message/weight hashes per leg. The existing
`requestDestinationHash` and `requestMessageHash` remain the first-leg hashes
for compatibility. `RequestQueued` is emitted once. Existing payload/dispatch
events remain, and new leg-indexed events make the two dispatches unambiguous to
operators and indexers.

The local leg uses a canonical `Here` destination sentinel in the unchanged
`destination` argument. It invokes the XCM precompile's
`execute(bytes, Weight)` entry point. The three remote legs require their exact
canonical destination and invoke `send(bytes,bytes)`. A caller cannot select
`execute` versus `send`; the decoded allowlisted shape selects it.

### Adapter and custody handshake

Each enabled `strategyId` is owner-bound to one async custody adapter. The
adapter stages the AAC allocation and exposes a request-scoped pull function
callable only by its configured wrapper. Before any first leg, the wrapper reads
the adapter request and checks the full tuple used by `previewRequestId`:

- strategy id and request kind;
- account, local asset, and recipient;
- requested assets/shares and nonce;
- pending, unsettled state.

For `DepositFunding`, the wrapper asks that adapter to release exactly
`context.assets` to the wrapper, verifies the wrapper's token balance delta, and
then calls XCM `execute` in the same EVM transaction. The adapter cannot dispatch
XCM, and the operator cannot pull an allocation that the adapter did not record.
The wrapper has no general token-withdraw function.

The adapter's request-staging entry point no longer dispatches the first XCM
message itself. The backend's already-gated `queueRequest` callback calls the
wrapper after AAC/adapter staging; the follow-up callback calls the same wrapper
selector for leg two. This is activation wiring, not an observer redesign.

On a successful withdrawal, returned USDC is deliberately addressed to the
wrapper on Asset Hub. During the existing nested
`AAC.settleStrategyRequest → adapter.settleRequest → wrapper.finalizeRequest`
path, the wrapper transfers exactly `settledAssets` to the associated adapter
before latching `Succeeded`; the adapter can then complete its existing transfer
and ledger update atomically. A zero or insufficient local wrapper balance
reverts instead of issuing an unbacked ledger credit.

Once a deposit funding leg has executed, its capital is remote. A timeout cannot
truthfully restore AAC liquid. The existing `finalizeRequest(..., Failed, 0, 0,
...)` call still marks the wrapper request terminal, but the nested adapter/AAC
failure path must distinguish local-refundable from remote-recovery-required.
For the latter it moves the requested amount from `pendingStrategyAssets` into
an explicit recovery bucket and does **not** credit `positions.liquid` or attempt
an unfunded adapter transfer. A request-scoped recovery call later credits only
the amount actually returned to Asset Hub and records any shortfall. This adds
ledger state/events, not a new observer status or wrapper queue/finalize
selector. No code may credit the original liquid amount merely because a remote
observation timed out. The deployment runbook must document this recovery state
before capital larger than dust is allowed.

## Payload allowlist v2

`_validateXcmPayload` becomes a strict structural decoder, not a collection of
permitted opcodes. It accepts exactly the four SCALE/XCM V5 fixture shapes that
passed the 2026-08-02 round trip. The implementation will commit the exact
fixture bytes alongside the already-recorded transaction and balance-delta
evidence in `hydration-bank-round-trip.json`.

All four shapes require canonical SCALE encodings, the fixture instruction
order and counts, no unparsed or trailing bytes, and a final declared
`SetTopic(requestId)`. Nested XCM is decoded to its end; a valid-looking outer
message cannot hide an extra inner instruction.

| Shape | Fixed fields | Request-parameter fields |
|---|---|---|
| `DepositFunding` | local `execute`; USDC asset 1337 location; Hydration `Sibling(2034)` reserve destination; the fixture's `DepositReserveAsset`/`BuyExecution`/`DepositAsset` structure | funding amount equals `context.assets`; remote beneficiary equals the configured wrapper converted `AccountId32`; topic equals `requestId` |
| `DepositSell` | remote `send` to `Sibling(2034)`; Hydration Router `sell`; filler `AAVE`; asset 22 in, asset 1003 out | sell amount is positive and no greater than `context.assets`; origin/deposit beneficiary remains the configured wrapper converted account; topic equals `requestId` |
| `WithdrawSell` | remote `send` to `Sibling(2034)`; Hydration Router `sell`; filler `AAVE`; asset 1003 in, asset 22 out | input amount equals `context.shares`; origin/deposit beneficiary remains the configured wrapper converted account; topic equals `requestId` |
| `WithdrawHome` | remote `send` to `Sibling(2034)`; fixture reserve-withdraw path targets Asset Hub `Parachain(1000)` and USDC asset 1337 | returned amount is positive and no greater than `context.shares` (the full aUSDC amount redeemed in this 1:1 USDC lane); Asset Hub beneficiary is the wrapper address, never caller-supplied; topic equals `requestId` |

The owner configures the one Hydration converted `AccountId32` used by all
remote-account checks while the wrapper is paused. It is not derived in
Solidity and it is never copied from the earlier EOA dust test. Activation
requires a fresh `LocationToAccountApi.convert_location` read for the deployed
wrapper origin. Changing that account, the Hydration para id, the local USDC,
the aUSDC identity, the Router call indices, or any instruction shape requires
a new reviewed contract version; the operator cannot configure them.

Mutations that must revert include a different asset, para id, Router pallet or
call, filler, direction, remote account, return beneficiary, request topic,
instruction order/count, nested instruction, amount outside its context bound,
non-canonical SCALE form, and trailing bytes. Supporting a fifth shape is a
contract change, not an environment switch.

## Roles and pause

| Capability | Authority | Bounds |
|---|---|---|
| Configure the single backend operator, strategy adapter binding, and wrapper converted account | `TreasuryPolicy.owner()` — the treasury multisig | Configuration only while the wrapper is paused; no raw dispatch helper |
| Queue/dispatch | configured backend operator | Existing `queueRequest` selector only; exact phase order; exact four decoded shapes; request must match an adapter record |
| Finalize through ledger path | associated adapter, reached by the existing backend-authorized AAC settlement call | Existing bounds and idempotency; successful withdrawal requires real wrapper balance |
| Emergency terminal/recovery actions | treasury multisig | Request-scoped; emitted; cannot alter a successful terminal record |
| Pause | treasury multisig or `TreasuryPolicy.pauser()` | Blocks new staging/dispatch and successful finalization; failure/recovery paths remain available |

The wrapper uses a local dispatch-pause flag in addition to the global policy
pause. A newly deployed wrapper starts locally paused. The backend signer has
no configuration, arbitrary-call, arbitrary-transfer, upgrade, or unpause
authority. Operator rotation is owner-only and does not change the operator
captured for an in-flight request without an explicit owner recovery action.

## Dry-run and settlement boundaries

The off-chain dry-run gate and the on-chain payload allowlist solve different
problems and both are mandatory:

- `XcmDryRunDispatchGuard` proves the exact bytes against current runtimes and
  asserts the expected forwarded sibling or `Broadcast.Swapped{AAVE}` event
  before the signing callback can run.
- `XcmWrapper` proves the signed calldata cannot dispatch anything outside the
  reviewed four-shape grammar or redirect value.
- `XcmBalanceObserverService` proves destination-state balance movement and
  supplies the actual delta.
- the unchanged `_validateSettlementBounds` caps that delta before a terminal
  record or ledger credit.

Dry-run evidence is never accepted as settlement evidence. XCM `complete`
without the expected event is a dispatch refusal; a dispatched message without
the expected balance delta is a failure/recovery incident.

## Implementation and test gate

After this design is approved, the implementation PR must include:

1. the precompile `execute` entry point, two-leg request storage/state machine,
   strict four-shape decoder, role/pause controls, and request-scoped custody;
2. the narrow adapter staging/pull/return changes needed for AAC custody
   continuity, without changing the wrapper's queue/finalize selectors;
3. fixture tests replaying all four exact round-trip messages and asserting the
   correct `execute`/`send` call, phase, destination, and hashes;
4. mutation tests for every fixed/bound field and for unexpected instructions,
   nested bytes, trailing bytes, wrong phase, conflicting replay, and a fifth
   message;
5. custody tests proving AAC/adapter capital is pulled exactly once, local
   execute failure rolls the pull back, an EOA never fronts funds, returned
   withdrawal assets reach the adapter before ledger credit, and a remote
   timeout enters the recovery bucket without creating fake liquid;
6. role tests for owner/operator/adapter/arbitrary caller, local and global
   pause behavior, operator rotation with an in-flight request, and the absence
   of an arbitrary token/XCM escape hatch;
7. settlement tests that run the existing bound suite unchanged and prove
   idempotent terminal replay; and
8. a full four-fixture accounting replay: fund → 22→1003 → 1003→22 → home,
   including the observer-facing request id and actual-delta values.

No test may replace fixture bytes with a hand-waved mock shape. Mocks may stand
in for the precompile and adapter side effects, but the decoder receives the
exact SCALE blobs and mutated derivatives.

## Deployment ceremony and post-deploy dust proof

Deployment is a separate, multisig-gated packet. Its ordered plan is:

1. deploy the wrapper locally paused, with TreasuryPolicy, USDC, Hydration/Aave
   constants, adapter binding, and backend operator reviewed;
2. construct the deployed wrapper's Asset Hub origin location and re-read
   Hydration `LocationToAccountApi.convert_location` for that exact origin;
3. compare the read through an independent endpoint, record the returned
   `AccountId32`, and configure it through the treasury multisig while paused;
4. configure the observer's asset-22 target at that AccountId32 and its aUSDC
   ERC-20 target at Hydration's chain-specific `truncate20(AccountId32)`;
5. dry-run all four exact wrapper-origin messages and assert the expected
   forwarded-XCM and `Broadcast.Swapped{AAVE}` evidence;
6. run one complete capped dust cycle through the wrapper itself, confirming
   adapter/wrapper custody and all four destination-state deltas between legs;
7. confirm the returned Asset Hub balance and ledger arithmetic, exercise the
   pause switch, and only then consider enabling a non-dust treasury limit.

Any converted-account mismatch, dry-run mismatch, missing event, missing or
oversized balance delta, stuck request, custody discrepancy, or unexpected
runtime metadata is a stop. There is no deployment, role grant, environment
flip, or real-capital movement in the design or implementation PR.
