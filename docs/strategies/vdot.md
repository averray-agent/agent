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
11–14% APY at time of writing), redeem DOT at the accrued rate when the
agent withdraws.

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
   call the XCM precompile to send DOT to the vDOT pallet on Bifrost.
   Returned vDOT shares come back via the same precompile. The adapter
   needs:
   - A deposit path that XCM-sends DOT and waits for the callback that
     credits vDOT shares.
   - A withdraw path that XCM-sends a redeem request and waits for DOT
     to settle back into the adapter's asset-hub balance.
   - Idempotency + partial-failure handling, because XCM is async.

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

## How to register the adapter (testnet)

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

For v1 on testnet: the `allocateIdleFunds` path on `AgentAccountCore`
records shares 1:1 with amount and does NOT currently invoke the
adapter's `deposit`. That integration (the contract-level wiring between
`AgentAccountCore` and `IStrategyAdapter`) is a follow-up PR that will
land alongside the first adapter redeploy. The adapter shape is pinned
now so the contract-side wiring has a stable target.
