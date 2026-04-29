# Strategy adapter: vDOT liquid staking

Status: **v1 — testnet only**. See "Mainnet migration" at the end for the
audit-and-integration path required before real user funds are routed
through this adapter.

---

## What this adapter is for

Agent accounts carry an on-platform balance sheet with a dedicated
`strategyAllocated` bucket. Funds in that bucket can be sent to a
registered strategy adapter to earn yield while they're idle —
Pillar 2 of [docs/AGENT_BANKING.md](../AGENT_BANKING.md).

The vDOT adapter is the canonical first strategy: take DOT, stake it via
Bifrost's liquid-staking primitive, earn Polkadot staking yield (roughly
5–6% base APY at time of writing; verify current Bifrost docs before launch),
redeem DOT at the accrued rate when the agent withdraws.

The next planned portfolio candidate is Hydration GDOT, documented in
[hydration-gdot.md](./hydration-gdot.md). It is deliberately v2 and opt-in:
GDOT adds Hydration, Bifrost, multi-hop XCM, liquidity, incentive, and possible
leverage exposure, so it must not become the default lane until vDOT has real
mainnet evidence.

Key properties for the platform:

- **Non-custodial.** The adapter never takes discretionary custody of
  agent funds. Every withdraw is deterministically computed from the
  caller's recorded shares and the contract's current `totalAssets`.
- **Share-based.** Accounting is classic vault math: `share_price =
  totalAssets / totalShares`. Deposits mint shares at the current price,
  withdrawals redeem at the current price. Prior yield accrual is not
  diluted by later depositors.
- **Operator-gated.** Only addresses the `TreasuryPolicy` lists as
  `serviceOperators` can call `deposit` / `withdraw`. In practice that's
  `AgentAccountCore` + `EscrowCore`, not user wallets directly.
- **Pausable.** Halts with `TreasuryPolicy.paused`. The hot-key pauser
  described in [docs/MULTISIG_SETUP.md](../MULTISIG_SETUP.md) can freeze
  the adapter independently of owner calls.

---

## v1 implementation — `MockVDotAdapter`

[`contracts/strategies/MockVDotAdapter.sol`](../../contracts/strategies/MockVDotAdapter.sol)
is a **self-contained** mock: it accepts DOT-denominated ERC20 deposits,
mints proportional shares, and lets the policy owner simulate yield
accrual via a governance call (capped at 500 bps per call).

This exists because real Bifrost vDOT on Polkadot Hub is **not an EVM
ERC20**. It's reached via XCM messages from the asset-hub runtime, which
requires cross-consensus plumbing our current Solidity adapter can't
speak directly. Shipping a partial XCM integration that only works on
mainnet would be worse than shipping a mock with the same accounting
surface; the mock lets us:

- Exercise every call path in `AgentAccountCore` + the registry.
- Prove out the UX (deposit → idle balance → withdraw → yield) on Anvil
  and on Polkadot Hub TestNet.
- Verify integrations (backend `/strategies` read surface, frontend
  balance display) before betting real staking yield on them.

### Simulating yield

```bash
# From the policy owner (deployer on dev, multisig on prod):
cast send "$ADAPTER_ADDRESS" "simulateYieldBps(uint256)" 250 \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY"
```

That bumps `totalAssets` by 2.5% of its current value — every share is
now worth 2.5% more DOT than before the call. Share balances don't move
but `maxWithdraw` does.

The cap (500 bps per call) is a guardrail against a typo that would
otherwise mint the contract an arbitrary supply of "yield" in one tx.

---

## Mainnet migration — what this v1 doesn't do

**Do not register `MockVDotAdapter` on mainnet.** The simulateYield knob
alone disqualifies it. Real mainnet vDOT needs a different contract
shape:

1. **Source of yield reads.** Instead of `simulateYieldBps`, the adapter
   needs an on-chain read against Bifrost's `vDOT` token or runtime
   storage that reports the accrued exchange rate. `totalAssets` becomes
   a view that computes `totalShares * bifrostRate`.

   2. **Cross-chain deposit/withdraw.** On Polkadot Hub, EVM contracts can
      call the XCM precompile at
      `0x00000000000000000000000000000000000a0000` to send DOT to the vDOT
   pallet on Bifrost. The official Polkadot docs are explicit that this
   precompile is barebones: messages must be SCALE-encoded and
   `weighMessage` is part of the execution flow. Returned vDOT shares
   come back via the same precompile. The adapter therefore needs:
   - A deposit path that XCM-sends DOT and waits for the callback that
     credits vDOT shares.
   - A withdraw path that XCM-sends a redeem request and waits for DOT
     to settle back into the adapter's asset-hub balance.
   - Idempotency + partial-failure handling, because XCM is async.
      In practice this likely means a dedicated XCM-wrapper layer rather
      than embedding raw precompile calls directly into vault accounting.
      The transport seam now lives at
      [`contracts/interfaces/IXcmWrapper.sol`](../../contracts/interfaces/IXcmWrapper.sol),
      and the first concrete async request ledger is
      [`contracts/XcmWrapper.sol`](../../contracts/XcmWrapper.sol). That
      wrapper already gives us deterministic request IDs, payload-hash
      pinning, and explicit finalize semantics before the real Bifrost
      message builders exist. The backend and indexer can now already
      inspect and finalize those request records through the optional
      `XCM_WRAPPER_ADDRESS` path, so the remaining missing piece is the
      production adapter that queues real Bifrost-bound messages. The
      first production-shaped version of that adapter now exists at
      [`contracts/strategies/XcmVdotAdapter.sol`](../../contracts/strategies/XcmVdotAdapter.sol):
      it queues deposit/withdraw requests through `IXcmWrapper` and only
      mutates adapter accounting once settlement is finalized.

3. **Audit.** The v1 adapter uses `ReentrancyGuard` + `SafeTransfer` +
   `whenNotPaused` — but any XCM-extended adapter adds message-parsing
   and async-callback surface that must be audited top-to-bottom before
   mainnet. This is scope (3) in
   [docs/AUDIT_PACKAGE.md](../AUDIT_PACKAGE.md) and should be flagged as
   a *separate* audit item from the core contract suite.

4. **Economic parameters.**
   - Withdrawal queue / unbond period. Bifrost vDOT can redeem at the
     current rate but the underlying DOT is bonded — a run on the
     adapter may need the queue semantics `IStrategyAdapter` doesn't
     currently expose. We may need a `requestWithdraw` → `claim` pair
     alongside the existing instant `withdraw` for large exits.
   - Fee accounting. Bifrost takes a validator commission. The adapter
     should expose it so `maxWithdraw` is honest about the net.
   - Asset identity and precompile derivation. Polkadot Hub's ERC20
     precompile model distinguishes trust-backed assets from foreign
     assets, and foreign assets use a runtime-assigned index rather than
     a raw XCM location as the address derivation input. Mainnet config
     should model that explicitly instead of relying on a single static
     token-address assumption.

5. **Removal of the owner knob.** `simulateYieldBps` must be deleted
   before mainnet deploy. The audit signs off on the code in the repo,
   not on a "we promise to delete it" claim.

---

## Risks agents should know about

Every surface that routes user funds through the adapter should
reproduce this disclosure verbatim:

> Funds allocated to the vDOT strategy adapter are subject to Bifrost's
> smart-contract risk. In the event of an exploit, losses flow through to
> your account. Averray does not insure strategy losses.

The v1 mock adapter additionally carries a **testnet-only** risk tag:
simulated yield is a governance knob; the accrued yield is not real
staking yield. Do not present v1 APY numbers to real users as
expectations for mainnet.

---

## How to register the adapters (testnet)

The deploy script has a `--with-vdot-mock` path that deploys the
adapter and registers it with the strategy registry. Rough shape:

```bash
PROFILE=testnet \
RPC_URL=https://eth-rpc-testnet.polkadot.io/ \
PRIVATE_KEY=0x... \
TOKEN_ADDRESS=0x<hub-dot-erc20> \
OWNER=0x<multisig-mapped-evm> \
PAUSER=0x<hot-key-evm> \
VERIFIER=0x<verifier-evm> \
ARBITRATOR=0x<arbitrator-evm> \
WITH_VDOT_MOCK=1 \
./scripts/deploy_contracts.sh
```

The resulting manifest (`deployments/testnet.json`) adds a `strategies`
section with the adapter address and its `strategyId`. The backend reads
that manifest so `/strategies` surfaces the registered adapter in its
list.

For the real async XCM-shaped staging lane, use `XcmWrapper` plus
`XcmVdotAdapter` instead of the mock adapter:

```bash
PROFILE=testnet \
RPC_URL=https://eth-rpc-testnet.polkadot.io/ \
PRIVATE_KEY=0x... \
TOKEN_ADDRESS=0x<hub-dot-or-staging-token-erc20> \
OWNER=0x<multisig-mapped-evm> \
PAUSER=0x<hot-key-evm> \
VERIFIER=0x<verifier-evm> \
ARBITRATOR=0x<arbitrator-evm> \
WITH_XCM_WRAPPER=1 \
WITH_XCM_VDOT_ADAPTER=1 \
./scripts/deploy_contracts.sh
```

This writes `contracts.xcmWrapper` and a `strategies[]` entry shaped for the
backend:

- `kind: "polkadot_vdot"`
- `executionMode: "async_xcm"`
- local accounting asset: `TOKEN_ADDRESS`
- XCM destination parachain: `2030` (Bifrost by default)

`WITH_XCM_VDOT_ADAPTER=1` is intentionally blocked for `PROFILE=mainnet` until
the native XCM evidence pack passes. The mock and XCM adapter paths are
mutually exclusive for a single deployment manifest.

For backend config, the preferred `STRATEGIES_JSON` shape is now the
explicit asset-metadata form rather than a bare asset address. That lets
the backend carry:

- asset class (`trust_backed`, `foreign`, `pool`, `custom`)
- asset ID or foreign asset index
- derived ERC20 precompile address
- symbol / decimals
- optional XCM location context for foreign assets

This is especially important for mainnet vDOT, where the asset identity
is not just "one token address" but part of the real Polkadot Hub asset
model.

After deployment, copy the manifest strategy list into backend env as
`STRATEGIES_JSON`, and copy `contracts.xcmWrapper` into `XCM_WRAPPER_ADDRESS`.
The helper `scripts/write_server_env.sh` preserves `STRATEGIES_JSON` when it is
already exported.

---

## What an agent sees

Once the adapter is registered and the agent has deposited DOT into
`AgentAccountCore`, the allocation flow is:

```
agent account (liquid)
  --allocateIdleFunds(strategyId, amount)-->
    agent account (strategyAllocated)  ← shares recorded
    adapter.deposit(amount)            ← DOT moves into adapter, shares minted

time passes, yield accrues (mock: simulateYieldBps; mainnet: vDOT rate drift)

agent account (strategyAllocated) + accrued yield
  --deallocateIdleFunds(strategyId, shares)-->
    adapter.withdraw(shares, account)
    agent account (liquid) ← DOT back
```

That is still the correct flow for the synchronous mock adapter on
testnet.

For the real async XCM lane, the flow is now split explicitly:

```
agent account (liquid)
  --requestStrategyDeposit(...)-->
    agent account (pendingStrategyAssets)  ← local DOT reserved for async lane
    XcmVdotAdapter.requestDeposit(...)     ← wrapper-backed XCM request queued

XCM settles later

operator / watcher
  --settleStrategyRequest(...)-->
    success: strategy shares booked, strategyAllocated refreshed
    failure: local DOT refunded back to liquid
```

And for exits:

```
agent account (strategy shares)
  --requestStrategyWithdraw(...)-->
    pendingStrategyWithdrawalShares       ← shares reserved for async exit
    XcmVdotAdapter.requestWithdraw(...)   ← wrapper-backed withdraw queued

XCM settles later

operator / watcher
  --settleStrategyRequest(...)-->
    success: shares burned, DOT credited back to liquid if recipient is AgentAccountCore
    failure: shares remain with the agent
```

So the repo now has both lanes:
- synchronous mock treasury flow through `allocateIdleFunds` /
  `deallocateIdleFunds`
- production-shaped async treasury flow through
  `requestStrategyDeposit` / `requestStrategyWithdraw` /
  `settleStrategyRequest`

That async lane is now exposed through the hosted backend too:
- strategy config can mark a lane as `async_xcm`
- `/account/allocate` and `/account/deallocate` will queue async XCM
  requests for those lanes instead of calling the sync adapter surface
- `/account/strategies` reports pending async posture
- `/admin/xcm/finalize` now settles the strategy-backed request through
  `AgentAccountCore`
- the backend now also has an XCM settlement watcher that can ingest
  observed outcomes and auto-finalize pending requests
- the backend also now includes `XcmObservationRelayService`, which polls
  an external observer feed, stores its cursor durably, and relays
  terminal XCM outcomes into that watcher automatically
- the indexer now exposes the matching cursor-based producer contract at
  `/xcm/outcomes`, so the feed shape is fixed before the full
  network-specific Bifrost watcher lands
- the indexer now also supports a durable publisher worker behind that
  contract: when configured with `XCM_EXTERNAL_SOURCE_TYPE=feed`, it polls
  the upstream watcher feed and persists published outcomes for
  `/xcm/outcomes`
- the same publisher can now also run with
  `XCM_EXTERNAL_SOURCE_TYPE=subscan_xcm`, using Subscan's official XCM API
  transport as the first concrete external source shape
- the Subscan field mapping is still intentionally defensive and should be
  validated against real paid-plan payloads before we treat it as mainnet
  settlement truth
- the repo now ships `scripts/ops/validate-subscan-xcm-source.mjs` for that
  staging validation pass, including direct transport checks, sample capture,
  and optional confirmation that the indexer published feed is actually live
- until we pay for a third-party observer or build the native Polkadot /
  Bifrost observer, the active execution lane is the hosted internal one:
  queue a request, inspect `/xcm/request`, observe a result through the admin
  path, and let the watcher settle it. That rehearsal flow now lives in
  `docs/ASYNC_XCM_STAGING.md` and
  `scripts/ops/exercise-async-xcm-request.mjs`.

What is still missing is the network-specific observer feed itself: the
repo now supports `observer feed -> durable cursor -> observe outcome ->
durable queue -> auto-finalize`, but operators still need a real
Bifrost/XCM relayer that exposes those terminal outcomes through
`XCM_OBSERVER_FEED_URL`.

The native observer design lives in
[`docs/NATIVE_XCM_OBSERVER.md`](../NATIVE_XCM_OBSERVER.md). Its first gate is
not a watcher loop; it is proving deterministic correlation between an
Averray `requestId` and native Hub/Bifrost settlement evidence.
