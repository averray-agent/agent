# Strategy adapter: Hydration GDOT

Status: **v2 planning only**. Do not register or market this strategy until the
vDOT lane has real production evidence, the native observer correlation gate is
closed, and this adapter has its own implementation and audit plan.

---

## Purpose

Hydration GDOT is the first candidate for a higher-yield, opt-in strategy after
the Bifrost vDOT lane is stable. It belongs in the portfolio because it gives
agents a risk dial:

- vDOT: moderate default, single vendor, single-hop XCM, never framed as max
  yield
- GDOT: opt-in composite yield, higher expected return, materially wider risk
  and correlation surface

GDOT must not replace vDOT as the default. It is an upgrade path for agents who
explicitly accept Hydration, Bifrost, liquidity, leverage, and multi-hop XCM
risk.

## Verified external facts

Checked 2026-04-29.

- Polkadot Hub supports native and foreign assets. Foreign assets are identified
  by XCM location and can move across parachains through XCM.
  Source: Polkadot docs MCP, `reference/polkadot-hub/assets.md`.
- Polkadot's documented XCM transfer workflow includes dry-runs, fee estimates,
  and existential-deposit checks before execution.
  Source: Polkadot docs MCP,
  `chain-interactions/send-transactions/interoperability/transfer-assets-parachains.md`.
- Hydration positions GIGADOT/GDOT yield as a composition of vDOT staking,
  aDOT lending, pool fees, and Hydration/Polkadot treasury incentives. The
  current planning band should be treated as roughly 15-20%+ only when leverage,
  market conditions, and incentives line up; it is not a fixed APY promise.
  Sources: [Hydration GIGADOT docs](https://docs.hydration.net/products/strategies/gigadot)
  and Hydration publications recorded in
  [AVERRAY_VERIFICATION_LEDGER.md](../AVERRAY_VERIFICATION_LEDGER.md).
- Hydration Borrow supports collateralized borrowing against GDOT/GETH-style
  collateral for HOLLAR or supported assets, per the same verification ledger.
- Bifrost vDOT remains a Bifrost SLP/vToken asset where staking rewards accrue
  through the vDOT/DOT exchange rate.
  Sources: [Bifrost vDOT docs](https://docs.bifrost.io/faq/what-are-vtokens/vdot)
  and [Bifrost vDOT product page](https://bifrost.io/vtoken/vdot).

## Architecture

`HydrationGdotAdapter` should follow the existing async adapter shape:

```text
AgentAccountCore
  -> StrategyAdapterRegistry
  -> HydrationGdotAdapter
  -> XcmWrapper
  -> Polkadot Hub XCM precompile
  -> Hydration / Bifrost route
```

It should not embed raw XCM dispatch in account balance logic. It should queue
requests through `XcmWrapper`, use `previewRequestId(context)` for idempotency,
append `SetTopic(requestId)` in the backend message builder, and settle only
after an observer publishes terminal evidence.

The adapter is **not** a copy of `XcmVdotAdapter`. It should reuse the
transport boundary but own different strategy semantics:

- multi-hop route: Hub -> Hydration -> Bifrost -> Hydration -> Hub
- composite asset accounting instead of simple vDOT share accounting
- Hydration-specific terminal evidence
- Hydration-specific failure codes
- explicit withdrawal delay and slippage handling

## Proposed request types

The adapter should support three high-level intents:

| Intent | Purpose | Settlement output |
|---|---|---|
| `deposit_dot_to_gdot` | Move idle DOT into the GDOT composition route. | GDOT shares or equivalent strategy shares. |
| `withdraw_gdot_to_dot` | Exit the strategy back to DOT. | DOT credited back to `AgentAccountCore`. |
| `claim_or_rebalance` | Harvest, rebalance, or refresh strategy accounting when Hydration exposes a safe primitive. | Updated share price or no-op receipt. |

Do not add automatic leverage in v1 of the adapter. If leverage is ever used,
make it a separate opt-in strategy profile with lower caps and stronger
disclosure.

## Observer requirements

The single-hop vDOT observer gate is necessary but not sufficient. GDOT needs a
new evidence pack with Hydration-specific artifacts:

- Hub outbound `messageTopic == requestId`
- Hydration receipt of the request
- Bifrost vDOT leg if the route mints or redeems vDOT underneath
- Hydration terminal event/storage proof for GDOT position update
- return-leg evidence to Hub, or a documented fallback if the topic is not
  preserved across every hop

The native evidence pack checker can remain the top-level promotion gate, but
the GDOT implementation should add route-specific validators before automated
settlement is allowed.

## UX and risk disclosure

GDOT must be opt-in. Every allocation surface should show:

> GDOT is a composite Hydration strategy. It may involve Hydration, Bifrost,
> Omnipool/liquidity mechanics, incentives, and multi-hop XCM settlement.
> Yield is variable and losses are not insured by Averray.

The UI/API should expose at least:

- strategy status: `planning`, `staging`, `enabled`, `paused`
- execution mode: `async_xcm_multi_hop`
- expected settlement window, once measured
- current leverage profile: `none`, `conservative`, or explicit numeric ratio
- vendor dependencies: Hydration and Bifrost
- whether incentives are included in displayed APY
- slippage tolerance and exit delay, if applicable

Never show a headline APY without a timestamp and source label.

## Launch gates

- [ ] vDOT native observer evidence pack passes for deposit, withdrawal, and
  failure.
- [ ] Hydration route evidence pack exists and passes for deposit, withdrawal,
  and failure.
- [ ] Adapter implementation uses `XcmWrapper`; no caller-supplied raw XCM bytes
  reach HTTP surfaces.
- [ ] Strategy-specific failure codes are documented.
- [ ] APY display distinguishes base yield, incentives, fees, and leverage.
- [ ] Audit includes Hydration adapter, message builder, observer matching, and
  settlement finalization.
- [ ] Risk disclosure appears in API metadata and operator/agent UX.

## Non-goals

- No auto-allocation.
- No default leverage.
- No production routing before vDOT is stable.
- No user-facing APY promise.
- No fallback to manual operator judgment for settlement truth.
