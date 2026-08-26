# PACKET — DepositPool v2.1: an adapter is not an agent

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), contracts + tests** · One PR.
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` **R1–R5 + Q1′** (RATIFIED). The memo
wins on any disagreement.

**This PR is contract source + tests only. It deploys nothing, migrates
nothing, registers nothing, and wires nothing.** The deploy is a later
ceremony runsheet; the AAC-side adapter is a later packet.

## Why v2.1 exists

DepositPoolV2 treats every share-holder as an agent. Two guards therefore
bind a strategy adapter that aggregates many agents' balances:

- `_checkAgentCap(receiver, …)` measures `balanceOf[receiver]` against
  `PER_AGENT_ASSET_CAP` — one adapter inherits one agent's 100 USDC allowance
  for the whole platform.
- `_recordAgentShareHighWater(receiver)` makes the adapter's balance the new
  `maxIssuedAgentShares`, so `bufferFloor` rises with it and
  `deployable = (buffer + X) − X` — flat for any contribution X.

The live pool is **immutable** (verified: no upgrade surface, not a proxy), so
the fix is a new deployment. **v2.1 is a minimal diff of the v2 source** —
reviewable as a diff, not a rewrite.

## The change, exactly

**1 — An owner-set aggregator registry on the pool.**

```solidity
mapping(address => bool) public aggregatorAdapters;
function setAggregatorAdapter(address adapter, bool enabled) external; // onlyOwner
event AggregatorAdapterSet(address indexed adapter, bool enabled);
```

`onlyOwner` here must resolve exactly as the registry's does —
`policy.owner()`, the cold 2-of-3 multisig — never the operator or any hot
key. R2's scope rule: only addresses this mapping names are exempt, never
arbitrary contracts. Reject `address(0)` and `address(this)`.

**2 — Both deposit paths skip the two agent guards for aggregators.**

When `aggregatorAdapters[receiver]`: skip `_checkAgentCap` and
`_recordAgentShareHighWater`. **`_checkTotalCap` runs unconditionally** — the
1000 USDC systemic ceiling binds aggregators too (ratified Q2 boundary).
`_requireAgentReceiver` stays as-is.

**3 — R3, enforced in the contract: aggregators exit async only.**

In `redeem()`: revert (named error, e.g. `AggregatorMustUseNoticeExit`) when
`aggregatorAdapters[owner]`. `requestRedeem` remains open to them. This is the
other half of the trade — the buffer floor stops reserving against the
aggregator precisely because the aggregator cannot draw the buffer
synchronously. R2 without R3 is a genuine weakening; neither lands alone.

**4 — Everything else byte-identical to v2.** No renames, no reordering, no
drive-by cleanups. The audit surface of this PR is the diff.

## D-03 — do not brick the deploy pipeline

The contract-surface deploy gate **fails closed on any contract change without
a manifest entry**. This PR must therefore carry the
`knownUnshippedContractChanges` waiver for the new artifact in the same PR —
exact masked runtime hash, per the established escrowCore precedent —
or the first deploy after merge fails. Follow the existing waiver shape in
`deployments/mainnet.json`; note Tier-1 path-match behaviour means the
waiver-landing deploy needs the `verify_contract_source=1` dispatch (recorded
in the ops memory; flag it in the PR description for the operator).

Local forge must run the pinned toolchain **v1.7.1** — local green implies CI
green only under toolchain parity.

## Non-negotiables (each pinned by a forge test)

1. **An aggregator deposit above 100 USDC succeeds** and moves **neither**
   `maxIssuedAgentShares` **nor** `bufferFloor`. Assert the exact before/after
   values, not just success.
2. **An agent deposit still hits `AgentAssetCapExceeded` at the cap and still
   records the high-water.** The exemption must not leak to agents.
3. **`_checkTotalCap` still binds an aggregator** — a deposit pushing
   `totalAssets` past `TOTAL_ASSET_CAP` reverts regardless of who deposits.
4. **Aggregator `redeem()` reverts with the named error; `requestRedeem`
   succeeds** for the same shares in the same state.
5. **`setAggregatorAdapter` is owner-only** — operator and arbitrary callers
   revert; the event is emitted; `address(0)`/`address(this)` rejected.
6. **De-flagging an aggregator restores agent semantics**: after
   `setAggregatorAdapter(a, false)`, its next deposit records high-water and
   is cap-checked again.
7. **Differential guard**: for a plain agent, deposit/redeem behaviour on
   v2.1 is byte-equivalent to v2 (same values, same reverts) across the happy
   path and each guard revert.

## Out of scope

Deployment, migration, the registry/policy multisig calls, the AAC-side
adapter, app/backend wiring, and any change to notice tiers, vesting, caps,
or venue mechanics.

## Handback requirements

PR number; green CI; the seven test names; the full v2→v2.1 source diff
(expected to be small — say how many lines); the masked runtime hash entered
in the waiver; and confirmation that nothing outside the contract, its tests,
and the manifest waiver changed.
