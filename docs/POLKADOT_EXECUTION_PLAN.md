# Polkadot Execution Plan

Updated: 2026-04-22

This is the canonical implementation plan for making Averray the best
product we can ship on Polkadot Hub without over-promising what is not
production-ready yet.

It combines:

- the Phase 1 launch plan
- the official Polkadot platform alignment work
- the practical MCP research workflow we now have for official docs

---

## Core decision

Build in this order:

1. Make trusted work + portable identity the launch wedge.
2. Make Polkadot-specific operator and asset assumptions correct.
3. Build the real treasury layer as an XCM integration system, not a
   marketing abstraction over the mock adapter.

That sequencing keeps the product honest and still gives us a path to a
very strong Polkadot-native moat.

---

## What we learned

### 1. REVM remains the right execution path now

Official Polkadot Hub docs confirm that Solidity + REVM is a first-class
path and works with the Ethereum tooling we already use.

Decision:

- Keep Solidity / REVM as the primary contract target.
- Do not split attention into a PVM migration before the trust core and
  treasury rails are materially further along.

### 2. The real treasury path is XCM-heavy

Official Polkadot docs confirm that contracts can use the XCM
precompile at `0x00000000000000000000000000000000000a0000`, but it is
barebones:

- XCM messages must be SCALE-encoded.
- `weighMessage` is part of the flow.
- async execution and settlement are real concerns.

Decision:

- The production vDOT lane needs an XCM-wrapper layer.
- We should not pretend the mock adapter is one refactor away from
  mainnet.

### 3. Asset configuration needs to be explicit

Official ERC20 precompile docs confirm that Polkadot Hub assets are not
one flat token model. We need to account for:

- trust-backed assets
- foreign assets
- pool assets

Foreign assets use a runtime-assigned index for ERC20 precompile address
derivation rather than a raw XCM location.

Decision:

- Treasury config must model asset class and derivation inputs, not only
  a static token address.

### 4. Owner / multisig mapping needed correction

Official Polkadot Hub account docs do not support our old "last 20
bytes" owner mapping assumption.

Decision:

- Ownership and operator control must be verified via the actual Polkadot
  Hub account model and rehearsed on testnet before mainnet use.

### 5. The Polkadot docs MCP is worth using continuously

We now have a working bridge to the official Polkadot docs MCP via:

- [polkadot-docs-bridge.mjs](/Users/pascalkuriger/repo/Polkadot/scripts/mcp/polkadot-docs-bridge.mjs)

Operationally, this matters because:

- it gives us a current primary-source research path
- it reduces guesswork for XCM, account-model, and asset-model work
- it lets us keep roadmap and implementation decisions tied to official
  docs rather than memory

Decision:

- Use the bridge-backed Polkadot docs MCP as the default research path
  for Polkadot-specific product and contract work.

---

## Product strategy

## 1. Launch wedge

Launch around:

- trusted work
- portable identity
- verifier-backed execution

Do not lead with:

- credit
- strategy yield
- agent treasury automation

until the treasury rail is real, auditable, and operationally honest.

## 2. Product surfaces

`Discover`

- public
- read-heavy
- low-risk
- directory-safe

`Execute`

- authenticated
- money-moving
- treasury-aware
- admin-aware

## 3. Positioning

Public positioning should say:

- we are strong at work, trust, and identity today
- treasury exists in beta / staged form
- Polkadot-native capital routing is a roadmap backed by real platform
  primitives, not hand-wavy marketing

---

## Engineering roadmap

## Phase 0. Source-of-truth and operator correctness

Priority: immediate

Goal:

- remove incorrect Polkadot assumptions before they leak into code or
  operational setup

Work:

- keep ownership and multisig docs aligned with official Hub account
  mapping behavior
- document the Polkadot MCP bridge as the preferred research path for
  Polkadot-specific implementation work
- require testnet verification for the `TreasuryPolicy.owner` path

Primary files:

- [docs/MULTISIG_SETUP.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_SETUP.md)
- [docs/POLKADOT_OFFICIAL_ALIGNMENT.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_OFFICIAL_ALIGNMENT.md)
- [scripts/mcp/polkadot-docs-bridge.mjs](/Users/pascalkuriger/repo/Polkadot/scripts/mcp/polkadot-docs-bridge.mjs)

Ship gate:

- no operator doc in the repo relies on the old last-20-bytes mapping
- owner-address verification is a required testnet step

## Phase 1. Trust-core first launch

Priority: immediate to short-term

Goal:

- ship the best trustworthy public product before expanding the finance
  story

Work:

- keep discovery manifest narrower than authenticated execution
- finish replayable verification
- enforce schema-native jobs at runtime
- centralize the session state machine
- strengthen idempotency for recurring and admin writes
- build one canonical timeline for claim, submit, verify, settle

Primary files:

- [mcp-server/src/core/discovery-manifest.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/discovery-manifest.js)
- [mcp-server/src/core/session-state-machine.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/session-state-machine.js)
- [mcp-server/src/core/job-schema-registry.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/job-schema-registry.js)
- [mcp-server/src/core/job-execution-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/job-execution-service.js)
- [docs/PHASE1_LAUNCH_PLAN.md](/Users/pascalkuriger/repo/Polkadot/docs/PHASE1_LAUNCH_PLAN.md)

Ship gate:

- public discovery is honest
- one hosted worker loop works end to end
- builders have examples and a first SDK path

## Phase 2. Asset metadata model

Priority: short-term

Goal:

- make treasury configuration match the real Polkadot Hub asset model

Work:

- define an explicit asset descriptor for:
  - asset class
  - asset ID or foreign asset index
  - derived ERC20 precompile address
  - decimals
  - symbol
  - risk label
- stop assuming one generic DOT-address input will scale into mainnet
- update strategy and backend config to use this model

Likely code/doc surfaces:

- [mcp-server/.env.example](/Users/pascalkuriger/repo/Polkadot/mcp-server/.env.example)
- [mcp-server/src/services/bootstrap.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/bootstrap.js)
- [mcp-server/src/services/strategies-config.test.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/strategies-config.test.js)
- [docs/AGENT_BANKING.md](/Users/pascalkuriger/repo/Polkadot/docs/AGENT_BANKING.md)
- [docs/strategies/vdot.md](/Users/pascalkuriger/repo/Polkadot/docs/strategies/vdot.md)

Current status:

- the strategy config parser now accepts an explicit asset descriptor and
  can derive Polkadot Hub ERC20 precompile addresses for
  `trust_backed`, `foreign`, and `pool` assets
- old `asset: "0x..."` entries still load for backward compatibility
- the broader blockchain config now accepts `SUPPORTED_ASSETS_JSON` with
  the same explicit asset metadata model and still preserves the old
  `SUPPORTED_ASSETS=SYMBOL:0x...` shorthand
- next step is to thread the same model through deployment manifests and
  strategy registration outputs so operators do not lose metadata at the
  deploy boundary

Ship gate:

- strategy config expresses real asset identity instead of only a static
  token address

## Phase 3. XCM wrapper boundary

Priority: medium-term

Goal:

- create a contract boundary that can actually talk to Polkadot Hub XCM
  safely enough to power a production strategy lane

Work:

- define a dedicated XCM wrapper interface around the official precompile
- handle SCALE-encoded message construction outside the core vault math
- support `weighMessage` before execution
- model async request lifecycle explicitly
- add idempotency and partial-failure recovery
- emit events that the backend / indexer can consume deterministically

Likely code surfaces:

- [contracts/interfaces/IXcmWrapper.sol](/Users/pascalkuriger/repo/Polkadot/contracts/interfaces/IXcmWrapper.sol)
- `contracts/strategies/`
- `contracts/AgentAccountCore.sol`
- `indexer/`
- `mcp-server/src/blockchain/`

Implementation rule:

- keep vault accounting separate from message transport logic

Current status:

- the first draft of the async transport boundary now exists at
  [contracts/interfaces/IXcmWrapper.sol](/Users/pascalkuriger/repo/Polkadot/contracts/interfaces/IXcmWrapper.sol)
- a first concrete ledger implementation now exists at
  [contracts/XcmWrapper.sol](/Users/pascalkuriger/repo/Polkadot/contracts/XcmWrapper.sol)
  with:
  - deterministic request IDs
  - payload-hash pinning for idempotent retries
  - durable pending / terminal request records
  - operator-gated finalize semantics
  - precompile-backed `weighMessage` support
- the contract path is covered by
  [test/XcmWrapper.t.sol](/Users/pascalkuriger/repo/Polkadot/test/XcmWrapper.t.sol)
  and passes with `forge test --match-contract XcmWrapperTest --offline`
- deployment manifests and the Ponder indexer now understand an optional
  `XcmWrapper` contract so request lifecycle events can be indexed in
  hosted environments before the real adapter wiring is finished
- the MCP/HTTP backend now also understands the optional wrapper:
  - `/xcm/request` can read one request by id with owner/admin scoping
  - `/admin/xcm/finalize` can finalize one request through the operator
    signer
  - the SSE event stream now emits `xcm.request_*` topics when the wrapper
    is configured
- next step is to replace the operator-only/manual finalize path with a
  real adapter + watcher flow that queues wrapper requests from treasury
  actions and settles them from observed XCM outcomes

Ship gate:

- the XCM layer is testable independently of the treasury vault logic

## Phase 4. Real vDOT strategy lane

Priority: after Phase 3

Goal:

- replace the mock lane with a production-shaped Bifrost path

Work:

- implement deposit request flow through the XCM wrapper
- implement withdraw request / claim flow for async settlement
- read real yield state from the correct Bifrost / runtime source
- remove `simulateYieldBps`
- expose honest liquidity and queue semantics to users
- label beta risk clearly until audit and production rehearsal are done

Primary files:

- [contracts/strategies/MockVDotAdapter.sol](/Users/pascalkuriger/repo/Polkadot/contracts/strategies/MockVDotAdapter.sol)
- [contracts/strategies/XcmVdotAdapter.sol](/Users/pascalkuriger/repo/Polkadot/contracts/strategies/XcmVdotAdapter.sol)
- [contracts/interfaces/IXcmStrategyAdapter.sol](/Users/pascalkuriger/repo/Polkadot/contracts/interfaces/IXcmStrategyAdapter.sol)
- [docs/strategies/vdot.md](/Users/pascalkuriger/repo/Polkadot/docs/strategies/vdot.md)
- [docs/PRODUCTION_CHECKLIST.md](/Users/pascalkuriger/repo/Polkadot/docs/PRODUCTION_CHECKLIST.md)

Current status:

- the first production-shaped async adapter path now exists at
  [contracts/strategies/XcmVdotAdapter.sol](/Users/pascalkuriger/repo/Polkadot/contracts/strategies/XcmVdotAdapter.sol)
  with:
  - `requestDeposit` queuing wrapper-backed deposit requests
  - `requestWithdraw` queuing wrapper-backed withdraw requests
  - explicit pending deposit / pending withdrawal accounting
  - operator-driven settlement that updates adapter assets/shares only
    after wrapper finalization
- `AgentAccountCore` now also understands the async lane through:
  - `requestStrategyDeposit(...)` for queueing a strategy deposit
  - `requestStrategyWithdraw(...)` for queueing a strategy withdraw
  - `settleStrategyRequest(...)` for booking the async outcome back into
    per-account treasury state
  - separate `pendingStrategyAssets` and
    `pendingStrategyWithdrawalShares` tracking so pending async activity
    is not confused with already-settled strategy balances
- failed async deposits now refund escrowed local DOT back into
  `AgentAccountCore` during settlement instead of stranding funds in the
  adapter
- the contract path is covered by
  [test/XcmVdotAdapter.t.sol](/Users/pascalkuriger/repo/Polkadot/test/XcmVdotAdapter.t.sol)
  and passes with `forge test --match-contract XcmVdotAdapterTest --offline`
- the treasury-core contract seam is now in place and covered by
  [test/AgentAccountAsyncStrategy.t.sol](/Users/pascalkuriger/repo/Polkadot/test/AgentAccountAsyncStrategy.t.sol),
  which passes with
  `forge test --match-contract AgentAccountAsyncStrategyTest --offline`
- the hosted stack now also understands the async lane:
  - strategy config supports `executionMode` and defaults
    `polkadot_vdot` to `async_xcm`
  - the backend ABI + gateway can queue strategy deposits/withdraws and
    settle strategy-backed XCM requests through `AgentAccountCore`
  - `/account/allocate` and `/account/deallocate` now branch to the async
    lane automatically when the selected strategy is `async_xcm`
  - `/account/strategies` now reports pending async deposit/withdraw
    posture alongside settled strategy shares
  - `/admin/xcm/finalize` now settles strategy-backed requests through
    `AgentAccountCore`, not only through the raw wrapper ledger
- an automatic settlement watcher now exists in the backend:
  - observed XCM outcomes can be ingested through the hosted stack
  - the watcher persists pending outcome observations durably in the
    state store
  - it auto-finalizes pending requests through
    `PlatformService.finalizeXcmRequest`
  - admin status can now surface watcher runtime + pending queue status
- the hosted stack now also ships the first external observation
  connector:
  - `XcmObservationRelayService` polls an operator-configured observer
    feed URL, persists its cursor durably, and relays terminal outcomes
    into `PlatformService.observeXcmOutcome(...)`
  - duplicate terminal outcomes no longer requeue an already-processed
    observation unless the payload actually changed
  - admin status now surfaces relay runtime, cursor, last sync time, and
    last relay error
- the remaining gap is the network-specific relayer feed itself:
  the repo now includes the connector the API needs, but operators still
  need a real observer feed that watches Bifrost / XCM results and serves
  them through the configured `XCM_OBSERVER_FEED_URL`
- the indexer now also exposes the first producer-side feed contract at
  `/xcm/outcomes`:
  - cursor-based pagination
  - terminal-only XCM outcomes
  - stable payload shape for the MCP relay to consume
  - this is the interface a future Bifrost/XCM watcher should publish
    behind, even if the upstream observation source changes
- the indexer now also includes the first durable publisher worker for that
  contract:
  - when `XCM_EXTERNAL_SOURCE_TYPE=feed` and `XCM_EXTERNAL_SOURCE_URL` is
    configured, a background publisher polls the upstream watcher feed
  - when `XCM_EXTERNAL_SOURCE_TYPE=subscan_xcm` is configured, the same
    publisher can use Subscan's official XCM API transport as the first
    real upstream source contract
  - published outcomes are stored durably in the indexer database
  - `/xcm/outcomes` will serve the published feed when it exists, instead
    of depending only on already-finalized terminal ledger state
  - the Subscan response mapping is intentionally defensive and still needs
    operator-side validation against real paid-plan payloads before it is
    treated as production-grade settlement truth
  - the repo now includes a dedicated validation harness at
    `scripts/ops/validate-subscan-xcm-source.mjs` so staging can check the
    direct Subscan transport, capture sanitized sample payloads, and verify
    that `/xcm/outcomes` is serving the published external feed

Ship gate:

- no owner-controlled fake yield mechanism remains
- exits are modeled honestly
- docs and UI no longer imply instant market-backed liquidity if that is
  not true

## Phase 5. Audit and mainnet gate

Priority: after production-shaped implementation

Goal:

- make the treasury rail something we can defend publicly

Work:

- separate audit scope for XCM adapter logic
- incident ownership and response path
- testnet rehearsal for owner / pauser / operator control
- end-to-end rehearsals for deposit, yield accounting, withdraw request,
  and failure recovery

Primary files:

- [docs/AUDIT_PACKAGE.md](/Users/pascalkuriger/repo/Polkadot/docs/AUDIT_PACKAGE.md)
- [docs/PRODUCTION_CHECKLIST.md](/Users/pascalkuriger/repo/Polkadot/docs/PRODUCTION_CHECKLIST.md)
- [docs/INCIDENT_RESPONSE.md](/Users/pascalkuriger/repo/Polkadot/docs/INCIDENT_RESPONSE.md)

Ship gate:

- we can explain exactly how the treasury rail behaves under success,
  delay, and failure

---

## Recommended order of implementation

1. Finish Phase 1 trust-core items and builder examples.
2. Introduce the asset metadata model.
3. Design the XCM wrapper interface and event model.
4. Build the real vDOT lane on top of that boundary.
5. Audit and rehearse before broad treasury positioning.

---

## Immediate sprint

If we start today, the highest-value next sprint is:

1. Add a repo-local note for using the Polkadot MCP bridge during design
   and implementation.
2. Turn treasury config into an explicit asset metadata model.
3. Draft the XCM wrapper interface and state machine before touching the
   production adapter.
4. Add one implementation checklist that ties trust-core, asset config,
   XCM wrapper, and audit gates together.

That gives us a plan that includes everything we learned and turns it
into concrete work rather than just better documentation.
