# XcmWrapper v2.1 — Hydration USDC two-phase custody and recovery design

Status: **v2.0 deployed, v2.1 replacement required after the first dust-cycle
incident; v2.1 implementation under review and not deployed**.

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
   accepts only one of the four request shapes in this document. The fifth
   owner-only recovery-home shape is separately derived, recorded, and fixed to
   the wrapper image.
4. The wrapper is the Asset Hub XCM origin for every leg. The local funding leg
   is executed by the wrapper; remote legs are sent by the wrapper. No EOA fronts
   capital or acts from a second remote identity.
5. Phase-1 capital moves treasury staging authority → adapter → wrapper → XCM.
   Only `TreasuryPolicy.owner()` can stage that treasury context. The wrapper
   pulls the adapter's recorded allocation in the same transaction that executes
   the funding message. If local XCM execution reverts, the pull reverts too.
6. `_validateSettlementBounds` retains its observer-delta boundary and adds a
   symmetric 1:1 withdraw check: both returned assets and retired shares are
   capped by `context.shares`. Destination-state balance deltas remain
   settlement truth; XCM completion alone is never enough.
7. Weighability is required only for `DepositFunding`, which Asset Hub executes
   locally. Hydration `Transact` messages are sent remotely and cannot be
   semantically weighed by Asset Hub; `send` success/revert is their atomic
   precompile-liveness boundary.

## v2.0 dust-cycle incident and disposition

On 2026-08-03, the v2.0 funding leg placed 149,412 raw asset 22 at converted
account `0x98f0033e26aa4ecf2899e6d09237d40d29fcb68e64d22a621520bde1123564ac`.
The exact `DepositSell` message then failed a limit-aware `ReviveApi_call`
inside the deployed wrapper with `XcmPrecompileUnavailable()` (`0x820c74ed`):
Asset Hub's XCM precompile returned `0/0` when asked to weigh a Hydration
`Transact` message. No sell signature was submitted. An earlier identity-split
rehearsal balance of 100,000 raw remains at
`0x089a0a57d001bacb8473161e007f0babc1768ceeeeeeeeeeeeeeeeeeeeeeeeee`.
Pascal explicitly wrote off both balances; neither may be relabelled as strategy
assets, operating float, or recoverable principal.

## Phase-1 treasury staging

Phase 1 does not call or modify the deployed AgentAccountCore. The treasury
multisig uses the adapter's explicit owner-only `stageTreasuryDeposit` and
`stageTreasuryWithdraw` entry points. Each call names a nonzero treasury context,
but capital custody and recovery authority are bound to the caller captured at
staging time: deposit USDC is pulled from `TreasuryPolicy.owner()`, successful
withdrawals return only to that same staging authority, and
`releaseRecoveredAssets` accepts only that authority and recipient. The backend
operator may dispatch the already-staged second leg and finalize observed deltas;
it cannot stage capital, become the requester, or redirect a return. An owner
rotation cannot rebind an existing request: an exact replay from any authority
other than the recorded requester reverts.

The adapter retains an immutable AgentAccountCore binding and its existing
`requestDeposit`/`requestWithdraw` interface for phase 2, but those methods and
all AAC-successor recovery accounting are outside phase 1. The parked branch
`codex/aac-successor-recovery-phase2` carries that successor work for the next
EscrowCore-family deployment window with MAIN-006 and `cancelOpenJob` v3.

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
canonical destination and invoke `send(bytes,bytes)` without calling
`weighMessage` on Asset Hub. A caller cannot select
`execute` versus `send`; the decoded allowlisted shape selects it.

### Owner-only recovery-home shape

While local dispatch is paused, `TreasuryPolicy.owner()` may call
`dispatchRecoveryHome(amount, nonce, destination, message)`. The wrapper derives
`recoveryId = keccak256(abi.encode("HYDRATION_USDC_RECOVERY_V1", wrapper,
hydrationAccountId32, amount, nonce))`, requires the fixed Hydration destination,
and strict-decodes the reserve-withdraw message. The amount is parameterized;
the beneficiary is not—it must be `wrapper H160 || 0xEE × 12` on Asset Hub—and
the final `SetTopic` must equal the derived recovery id. Exact replay is a no-op;
same-id/different-message replay reverts. The backend operator cannot call this
path or redirect its result. The nested remote execution fee must be positive
and no greater than the recovered amount.

Recovery is scoped to funds associated with an existing wrapper request. After
the reserve-withdraw lands at the wrapper's Asset Hub image, the only custody
exit is `releaseRecoveredAssetsToAdapter(requestId, assets)`: it requires that
request to be `Failed` or `Cancelled` and caps cumulative release at the
request's recorded deposit assets or withdraw shares. Funds recovered without
a matching request would remain at the wrapper with no general sweep path. That
constraint is intentional; operators must bind every recovery to a failed or
cancelled request rather than creating unaccounted wrapper float.

### Adapter and custody handshake

Each enabled `strategyId` is owner-bound to one async custody adapter. In phase
1, the owner-only treasury entry point transfers USDC from the staging authority
into the adapter and records that authority as `requester`; withdrawals record
the same authority as their only recipient. The adapter then exposes a
request-scoped pull function callable only by its configured wrapper. Before any
first leg, the wrapper reads the adapter request and checks the full tuple used
by `previewRequestId`:

- strategy id and request kind;
- account, local asset, and recipient;
- requested assets/shares and nonce;
- pending, unsettled state.

For phase 2, the adapter constructor also binds the deployed AgentAccountCore as
its immutable requester. `requestDeposit` and `requestWithdraw` reject every
other caller, including a funded EOA `strategySettler`. That future path is
tested and packaged with the AAC successor rather than this phase-1 PR.

For `DepositFunding`, the wrapper asks that adapter to release exactly
`context.assets` to the wrapper, verifies the wrapper's token balance delta, and
then calls XCM `execute` in the same EVM transaction. The adapter cannot dispatch
XCM, and the operator cannot pull an allocation that the adapter did not record.
The wrapper has no general token-withdraw function.

The adapter staging entry point dispatches the first XCM message atomically with
its custody pull. The backend's already-gated callback calls the same wrapper
selector for leg two. This is activation wiring, not an observer redesign.

On a successful withdrawal, returned USDC is deliberately addressed to the
wrapper on Asset Hub. During `adapter.settleRequest → wrapper.finalizeRequest`,
the wrapper transfers exactly `settledAssets` to the associated adapter before
latching `Succeeded`; the adapter then transfers only that amount to the recorded
treasury staging authority. A zero or insufficient local wrapper balance reverts
instead of issuing an unbacked accounting credit.

Once a deposit funding leg has executed, its capital is remote. A timeout cannot
truthfully refund it. `finalizeRequest(..., Failed, 0, 0, ...)` marks both wrapper
and adapter terminal and creates an explicit adapter recovery outstanding amount;
it never fabricates a local balance. If funding never left the adapter, failure
returns it directly to the staging authority. Otherwise an owner-operated XCM
returns observed assets to the wrapper, the paused wrapper releases only the
request-capped amount to the adapter, and the original staging authority releases
only that amount to itself. Partial recovery remains visible.

A failed withdrawal uses the same recovery discipline. Its context deliberately
stores `assets = 0`, so the wrapper's owner-only release cap is kind-aware:
deposit recovery is capped by `context.assets`, while withdrawal recovery is
capped by `context.shares` in this 1:1 USDC/aUSDC lane. Returned USDC moves
wrapper → adapter → recorded treasury staging authority. Each recovered unit
retires one adapter share before being returned; partial recovery leaves an
explicit outstanding counter, and full recovery clears it.

### Residual operating float

The converted Hydration account deliberately retains a small asset-22 operating
float for remote execution. It is persistent treasury working capital, not yield,
not an agent balance, and not part of a request's settled principal. The target
is an owner-reviewed runtime configuration derived from fresh dry-run fee quotes;
it is not hardcoded into the payload parser.

The rehearsal demonstrates why this must be explicit: leg C returned 107,113
raw asset 22 after redeeming 100,000 aUSDC shares. Treating the entire 107,113 as
the withdrawal would mix 7,113 of residual fee capital into the request's
principal. In v2, `WithdrawHome` returns at most the request principal and leaves
the configured operating float at the converted account. A later request tops
up only the measured shortfall below that target rather than funding a second
independent float.

The observer publishes the converted account's asset-22 balance, configured
float target, attributable in-flight amount, residual float, read endpoint, and
`asOf`. Adapter accounting records request principal separately from a
treasury-only `remoteOperatingFloat` bucket. Neither the float nor an unexplained
positive delta mints adapter shares or becomes withdrawable; the common health
surface must show low, target, excess, and stale/unknown states honestly.

Recovery is owner-mediated and only while dispatch is paused and no request is
using the float. It uses the same allowlisted `WithdrawHome` structure with the
Asset Hub wrapper as beneficiary, a distinct recorded recovery request, and
balance-delta confirmation. The wrapper then credits only the observed returned
amount to the treasury account. The backend operator cannot redirect, silently
sweep, or relabel the float as a request settlement.

## Payload allowlist v2.1

`_validateXcmPayload` is a strict structural decoder, not a collection of
permitted opcodes. The request allowlist is precisely the four rehearsal message
shapes, amended only with `SetTopic(requestId)` and wrapper-owned beneficiaries
in place of the rehearsal EOA beneficiaries. Those are new v2 bytes, not a claim
that the rehearsal payloads themselves already had the final wrapper shape.
Ceremony step 5 re-proves all four exact request messages plus the fifth recovery
message through DryRunApi before any wrapper-origin signature or dispatch.

The implementation commits and pins the exact v2 SCALE bytes used by contract
tests. `hydration-bank-round-trip.json` remains immutable provenance for the
rehearsal transactions, events, and balance deltas; it is not relabelled as a v2
payload fixture.

All five shapes require canonical SCALE encodings, the fixture instruction
order and counts, no unparsed or trailing bytes, and a final declared
`SetTopic(requestId)` or `SetTopic(recoveryId)`. Nested XCM is decoded to its end; a valid-looking outer
message cannot hide an extra inner instruction.

| Shape | Fixed fields | Request-parameter fields |
|---|---|---|
| `DepositFunding` | local `execute`; USDC asset 1337 location; Hydration `Sibling(2034)` reserve destination; the fixture's `DepositReserveAsset`/`BuyExecution`/`DepositAsset` structure | funding amount equals `context.assets`; remote beneficiary equals the configured wrapper converted `AccountId32`; topic equals `requestId` |
| `DepositSell` | remote `send` to `Sibling(2034)`; Hydration Router `sell`; filler `AAVE`; asset 22 in, asset 1003 out | sell amount is positive and no greater than `context.assets`; origin/deposit beneficiary remains the configured wrapper converted account; topic equals `requestId` |
| `WithdrawSell` | remote `send` to `Sibling(2034)`; Hydration Router `sell`; filler `AAVE`; asset 1003 in, asset 22 out | input amount equals `context.shares`; origin/deposit beneficiary remains the configured wrapper converted account; topic equals `requestId` |
| `WithdrawHome` | remote `send` to `Sibling(2034)`; fixture reserve-withdraw path targets Asset Hub `Parachain(1000)` and USDC asset 1337 | returned amount is positive and no greater than `context.shares` (the full aUSDC amount redeemed in this 1:1 USDC lane); Asset Hub beneficiary is the wrapper address, never caller-supplied; topic equals `requestId` |
| `RecoveryHome` | owner-only while locally paused; remote `send` to `Sibling(2034)`; same reserve-withdraw path targets Asset Hub `Parachain(1000)` and USDC asset 1337 | positive owner-declared amount and nonce derive `recoveryId`; Asset Hub beneficiary is the wrapper image; topic equals `recoveryId`; exact replay only |

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
non-canonical SCALE form, and trailing bytes. Supporting a sixth shape is a
contract change, not an environment switch.

## Roles and pause

| Capability | Authority | Bounds |
|---|---|---|
| Configure the single backend operator, strategy adapter binding, and wrapper converted account | `TreasuryPolicy.owner()` — the treasury multisig | Configuration only while the wrapper is paused; no raw dispatch helper |
| Queue/dispatch | configured backend operator | Existing `queueRequest` selector only; exact phase order; exact four request shapes; request must match an adapter record |
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
- `XcmWrapper` proves request calldata cannot dispatch outside the reviewed
  four-shape grammar and the owner cannot dispatch recovery outside its single
  fixed-beneficiary fifth shape.
- `XcmBalanceObserverService` proves destination-state balance movement and
  supplies the actual delta.
- `_validateSettlementBounds` caps that delta before a terminal record or
  ledger credit, including the symmetric withdraw-assets ≤ requested-shares
  defense in depth.

Dry-run evidence is never accepted as settlement evidence. XCM `complete`
without the expected event is a dispatch refusal; a dispatched message without
the expected balance delta is a failure/recovery incident.

## Implementation and test gate

The implementation is split across `XcmWrapperV2`, `HydrationUsdcAdapter`, and
the request-scoped `IXcmV2CustodyAdapter` handshake. The deployed
`AgentAccountCore` is byte-for-byte untouched. The exact contract-test bytes are committed in
`test/fixtures/xcm-wrapper-v2.json`; their message hashes are asserted by the
four-leg replay, while `hydration-bank-round-trip.json` remains the historical
rehearsal provenance.

The implementation test gate includes:

1. the precompile `execute` entry point, two-leg request storage/state machine,
   strict four-request-shape decoder, strict owner-recovery decoder,
   role/pause controls, and request-scoped custody;
2. the owner-only treasury staging/pull/return path, without changing the
   wrapper's queue/finalize selectors;
3. fixture tests replaying all four exact v2 messages and asserting the
   correct `execute`/`send` call, phase, destination, and hashes;
4. mutation tests for every fixed/bound field and for unexpected instructions,
   nested bytes, trailing bytes, wrong phase, conflicting replay, and a sixth
   message;
5. custody tests proving treasury capital is pulled exactly once, a backend EOA
   strategy settler cannot stage or front funds, local execute failure rolls the
   pull back, returned withdrawal assets reach the recorded staging authority,
   and remote deposit/withdraw failures remain request-scoped without fake
   balances or live retired shares;
6. role tests for owner/operator/adapter/arbitrary caller, local and global
   pause behavior, operator rotation with an in-flight request, and the absence
   of an arbitrary token/XCM escape hatch;
7. settlement tests that preserve the existing bounds, add the symmetric
   withdraw-assets cap, and prove idempotent terminal replay; and
8. a full four-leg accounting replay: fund → 22→1003 → 1003→22 → home,
   using pinned v2 payload bytes while retaining the rehearsal fixture as
   provenance for the observer-facing request and actual-delta values.

No test may replace v2 bytes with a hand-waved mock shape. Mocks may stand
in for the precompile and adapter side effects, but the decoder receives the
exact SCALE blobs and mutated derivatives.

## Deployment ceremony and post-deploy dust proof

Deployment is a separate, multisig-gated packet. Its ordered plan is:

1. deploy the wrapper and adapter, in that order, with the wrapper locally
   paused and TreasuryPolicy, USDC,
   immutable future AAC binding, Hydration/Aave constants, strategy binding,
   and backend operator reviewed;
2. construct the deployed wrapper's Asset Hub origin location and re-read
   Hydration `LocationToAccountApi.convert_location` for that exact origin;
3. compare the read through an independent endpoint, record the returned
   `AccountId32`, and configure it through the treasury multisig while paused;
4. configure the observer's asset-22 target at that AccountId32 and its aUSDC
   ERC-20 target at Hydration's chain-specific `truncate20(AccountId32)`;
5. dry-run all five exact wrapper-origin messages and assert the expected
   forwarded-XCM and `Broadcast.Swapped{AAVE}` evidence;
6. after configuration/arming, run a limit-aware `ReviveApi_call` through the
   deployed wrapper/adapter for each exact leg under the exact proposed outer
   limits. A message-level dry-run alone is never signature authority;
7. approve the adapter from the treasury staging authority and run one complete
   capped dust cycle through its owner-only staging path, confirming
   authority/adapter/wrapper custody and all four destination-state deltas;
8. confirm the returned Asset Hub balance and ledger arithmetic, exercise the
   pause switch, and only then consider enabling a non-dust treasury limit.

Any converted-account mismatch, dry-run mismatch, missing event, missing or
oversized balance delta, stuck request, custody discrepancy, or unexpected
runtime metadata is a stop. There is no deployment, role grant, environment
flip, or real-capital movement in the design or implementation PR.
