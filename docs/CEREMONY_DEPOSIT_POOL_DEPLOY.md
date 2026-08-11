# Ceremony — bringing the agent deposit pool live on mainnet

Status: **contract safety block removed; mainnet ceremony not yet run.** #1066 separates
pricing NAV from remote execution inventory, and the new bytecode passed the fork rerun in
§5b. `scripts/ops/deploy-deposit-pool.mjs --commit` is enabled again, subject to every
preflight and multisig step below.

---

## 0. The pricing capability is removed

An independent review (Codex, 2026-08-10, [#1050](https://github.com/averray-agent/agent/pull/1050))
falsified the original safety argument: a `strategySettler` could set the lane's reported
assets, reprice pool shares, and drain the buffer. #1066 removes that capability rather
than putting a sanity band around the observation.

```solidity
// HydrationUsdcAdapterV22 — gated on policy.strategySettler(msg.sender)
function recordRemotePosition(uint256 assets, ...) external onlyOperator {
    totalAssets = assets;     // arbitrary, caller-supplied
    totalShares = assets;
}

// Old DepositPool — share price derived from that book
function convertToAssets(uint256 shares) public view returns (uint256) {
    return (shares * totalAssets()) / supply;   // totalAssets() -> venueAdapter.managedAssets()
}                                               //                -> lane.totalAssets()
```

`deposit()` is not operator-gated, and `redeem()` pays from the buffer. The old composition
therefore allowed: deposit small, inflate the book as settler, redeem the buffer.

**This is not fixable by choosing a different `operator_`.** The capability lives in
`strategySettler`, which is a *global* mapping on TreasuryPolicy — so it is available to
every settler, whoever operates the pool. §3's analysis enumerated `DepositPool`'s
operator-gated functions correctly and then failed to compose them with the *lane's*
settler-writable book feeding the pool's price. The four-role concentration §3 files as
"worth unwinding at the next rotation" is not hygiene; it is the vulnerability.

### Landed design

`DepositPool.totalAssets()` is now exactly local buffer cash plus
`venuePrincipalCostBasis`. It never calls `managedAssets()`:

- increase cost basis only when the pool transfers principal out;
- decrease it when actual USDC returns, or when the TreasuryPolicy owner explicitly writes
  off a loss;
- recognise yield only when returned USDC reaches the local buffer — anything above remaining
  cost basis is realised yield.

Remote-position observations remain useful only for *sizing recalls* and never feed
`totalAssets`, caps, share conversion, the buffer floor, deposits, or redemptions. While
normal recall claims are balance-delta measured by the pool, the recovery path calls back
only after the immutable adapter has transferred USDC into the buffer. A settler cannot
write off principal: that path resolves `TreasuryPolicy.owner()` through the adapter.

Deposits and redemptions remain open while capital is deployed. Cost-basis NAV understates
unrealised venue value, so it cannot be used to extract more than the pool holds. It does,
however, create a known timing seam: yield lands as a step when USDC returns, so a depositor
can enter just before a profitable recall settles and exit after it, capturing yield they
did not earn. This is negligible at the 10 USDC launch size and real at scale; redesign the
yield allocation before increasing the pool materially.

The exact exploit regression, owner-only write-off, and cash-before-callback ordering are
covered in `test/DepositPool.t.sol` and `test/HydrationDepositPoolAdapter.t.sol`.

---

Companion to `docs/PACKET_AGENT_DEPOSIT_POOL.md`, which decides *what* the pool is. This
decides *how it gets deployed*, because the three contracts merged in #1038 and #1043 cannot
be deployed in an arbitrary order — they reference each other in a cycle, and only one
ordering satisfies all three constructors.

Profile: mainnet, chainId 420420419.

---

## 1. What is live today, and what is not

| | state |
|---|---|
| Operating bank position | **live** — 10,000,001 raw in Aave via Hydration since 2026-08-06 |
| `hydrationUsdcAdapter` 0x96091d44…3159 | **live**, on its pre-#1043 runtime |
| `DepositPool` | **source only** — absent from `deployments/mainnet.json`, never deployed |
| `HydrationDepositPoolAdapter` | **source only** |
| Pool's dedicated lane | **does not exist** |

The 2026-08-10 production deploy shipped `components: ["backend","indexer"]`. It deployed no
contracts. #1038 and #1043 merged source; the D-03 waiver added in #1047 records in as many
words that the live adapter is deliberately left on its pre-#1043 runtime.

So: no part of the deposit pool has ever existed on chain, and an outside agent has nothing
to touch yet.

---

## 2. The ordering constraint (the whole reason this document exists)

Three constructors, read from source at c48a22e:

```solidity
// DepositPool.sol:158
constructor(address asset_, address operator_, IDepositPoolVenueAdapter venueAdapter_)
    // :162  if venueAdapter_ != 0 → REQUIRES venueAdapter_.code.length != 0
    //                            → REQUIRES venueAdapter_.asset() == asset_
    //                            → REQUIRES venueAdapter_.lossReporter() != address(0)
    // :31   venueAdapter is IMMUTABLE — there is no setter, on purpose

// HydrationDepositPoolAdapter.sol:78
constructor(address pool_, IHydrationDepositPoolLane lane_)
    // :79   pool_ is only ZERO-checked — it is NOT code-checked
    // :82   REQUIRES lane_.agentAccountCore() == address(this)

// HydrationUsdcAdapterV22.sol:82
constructor(TreasuryPolicy policy_, address asset_, bytes32 strategyId_,
            IXcmWrapperV22 wrapper_, address agentAccountCore_)
    // agentAccountCore is IMMUTABLE — fixed at deploy
```

That is a cycle: the pool needs the venue adapter to already have code, the venue adapter
needs the pool's address, and the lane must be born already naming the venue adapter.

**It is satisfiable exactly once**, and only because `HydrationDepositPoolAdapter` does not
code-check `pool_`. That single asymmetry is what makes the ceremony possible; if a future
change adds a code check there, this ordering dies and the contracts become undeployable
without a redesign. Worth a comment in the source before someone "tightens" it.

### The only order that works

Let `D` be the deployer EOA and `n` its nonce at the start. CREATE addresses are
`keccak256(rlp([D, nonce]))[12:]`, so both forward addresses are predictable.

```
predict  A_adapter = CREATE(D, n+1)      # HydrationDepositPoolAdapter
predict  A_pool    = CREATE(D, n+2)      # DepositPool

tx 1 (nonce n)    deploy HydrationUsdcAdapterV22(policy, USDC, strategyId,
                         xcmWrapper, agentAccountCore = A_adapter)
tx 2 (nonce n+1)  deploy HydrationDepositPoolAdapter(pool_ = A_pool, lane_ = <tx1 address>)
                         → its constructor asserts lane.agentAccountCore() == itself ✓
tx 3 (nonce n+2)  deploy DepositPool(USDC, operator, venueAdapter = <tx2 address>)
                         → asserts venueAdapter has code ✓ and .asset() == USDC ✓
```

### The hazard, stated plainly

**Nothing else may be sent from `D` between tx 1 and tx 3.** One interleaved transaction —
a gas top-up, a retry, an unrelated ops script, an automated nonce-consuming job — shifts
every prediction. The failure is not a clean revert: tx 1 would deploy a lane permanently
bound to an address that will never hold the venue adapter, and that lane is immutable. It
would have to be abandoned and redeployed.

Mitigations, in order of preference:

1. Quiesce `D` for the ceremony — confirm no scheduled job uses it, and re-read the nonce
   immediately before tx 1.
2. Re-read the on-chain nonce between each transaction and abort if it is not what the
   prediction assumed. Cheap, and it converts a silent mis-wiring into a stop.
3. Do **not** wrap these in `batchAll`. FIND #19 (2026-08-06) established that
   approve+stage in one transaction has never worked here, and the live-proven shape is
   separate ceremonies. Same-transaction composition is a new shape needing its own proof;
   this is not the ceremony to discover that on.

---

## 3. Constructor arguments

From `deployments/mainnet.json` at c48a22e:

| argument | value | note |
|---|---|---|
| `asset_` / USDC | `0x0000053900000000000000000000000001200000` | precompile; emits no logs |
| `policy_` | `0x226F14252A98BD2eA140271647De20132F09AF20` | TreasuryPolicy |
| `wrapper_` | `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc` | live xcmWrapper (v2.2.1) |
| `strategyId_` | `HYDRATION_USDC_POOL_V1` (proposed) | must NOT reuse `HYDRATION_USDC_V1` |
| `agentAccountCore_` | `A_adapter` (predicted, §2) | immutable |
| `operator_` (pool) | `0x5a6836c6D4d293F6E5377E6c28054F4171915813` | the backend signing key — see below |

### `operator_` — a bounded role, so it does not need the multisig

The operator's entire power surface is three functions, and the contract bounds all of them:

| function | effect |
|---|---|
| `contributeOperatorPrincipal` | puts operator money **in** |
| `deployToVenue` | buffer → venue |
| `recallVenueDeployment` | venue → buffer |

- **No privileged withdrawal exists.** `DepositPool.sol:270` — *"Matching shares are
  permanently held by the pool contract. There is no privileged operator withdrawal path."*
  `redeem` / `requestRedeem` are not operator-gated.
- `returnBy <= block.timestamp + NOTICE_7_DAYS`, enforced (`:344`).
- One active deployment at a time (`:346`), one per `DEPLOYMENT_EPOCH` = 1 day (`:347`).
- `bufferFloor()` is protected (`:353`) — the instant tier's backing cannot be drained.

So a compromised operator key **cannot take depositor money**. The worst case is a liveness
annoyance: deploying the available buffer once a day, for at most seven days out.

Therefore not the multisig: `deployToVenue` and `recallVenueDeployment` are routine, and a
multisig ceremony per deployment would make the lane unusable in practice.

**Chosen: `0x5a6836c6D4d293F6E5377E6c28054F4171915813`** — the backend's KMS-backed signing
key. Identified from chain rather than the vault: it signs live EscrowCore settlements
(three observed in blocks 19,287,277–19,287,348), nonce 898, ~13.8 DOT, EOA.

Service-held is the deciding property. `operator` is immutable, and a key only a human holds
can never be driven by automation, whereas a service key can still be triggered by a human.
Choosing the automatable option keeps both paths open; choosing the hand-held one closes a
door that can only be reopened by redeploying the pool.

**Recorded concentration risk.** This address already holds three roles — manifest
`verifier`, TreasuryPolicy `strategySettler`, and backend transaction signer — so this makes
four. That is worth unwinding, but it is *not* an argument against using it here: the
verifier role can already settle job payouts and move real money, while the pool operator
provably cannot withdraw anything (see the bounds above). Adding the strictly weaker role to
a key that already holds the stronger one barely moves the blast radius.

The cleaner end state is a dedicated service-held key — a fresh unused EOA
`0x51818D396B598083589a67B6426bae86fedF0034` (nonce 0, unfunded) exists as a candidate. It
was not chosen now because it is not yet service-provisioned, and because migrating later is
cheap **while the pool is empty**: redeploying an empty pool costs gas and nothing else.
Revisit at the next key rotation, or before the pool holds meaningful depositor money —
whichever comes first.

### `strategyId_` — a label, not a control-flow key

Every consumer of `HYDRATION_USDC_V1` in the tree: `deployments/mainnet.json`,
`scripts/ops/bank-xcm-v2-ceremony-lib.mjs` (a module constant at `:14-15`), two test files,
and three historical ceremony docs. No production backend code branches on it.

So choosing a new string is safe; the hazard is **reuse**. The manifest `strategies` block
maps id → adapter, and two positions sharing one id would make the ops board conflate the
operating bank position with the pool's — a money view that lies rather than crashes.

### Settlement authority — already satisfied, no ceremony needed

The lane has two independent authority planes, and they are easy to confuse:

| plane | gate | who |
|---|---|---|
| capital movement — `requestDeposit` (`:128`), `requestWithdraw` (`:212`) | `onlyAgentAccountCore` | the **immutable** bound contract |
| settlement, `recordRemoteOperatingFloat`, `recordRemotePosition` | `onlyOperator` → `policy.strategySettler(msg.sender)` | an off-chain service |

The pool adapter draws its authority from *being* `agentAccountCore` — that is what the
immutable binding in §2 is for. **It does not need to be a settler.**

`strategySettler` is a global `mapping(address => bool)` on TreasuryPolicy, not per-adapter.
Read from mainnet 2026-08-10:

```
strategySettler(0x5a6836c6D4d293F6E5377E6c28054F4171915813) = true    # manifest `verifier`
strategySettler(0x9Ab8531FBb0948C542a31298FD61335f30064239) = false
strategySettler(0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1) = false   # deployer
strategySettler(0x01e6eed856e989201f4ff6346e18eab7e46c874c) = false   # multisig owner
```

Positive control on the same call path: `owner()` returns `0x01E6eed8…874C`, matching the
manifest — so those `false` results are answers, not a broken call.

**Consequence: the new lane accepts the existing settler automatically. No
`setStrategySettler`, no multisig round trip for this part.**

Two observations worth carrying forward rather than acting on now:

- The settler is the address the manifest labels `verifier`. Bank settlement authority and
  job-verification authority are the same key — role overloading, so one compromise touches
  both subsystems.
- The live operating lane's `agentAccountCore` reads `0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57`
  — the AgentAccountCore contract. The pool adapter is structurally an AAC-substitute for
  the pool's lane, which is the same seam as the O4 AAC-successor question.

### Predicted addresses

Computed against the live deployer nonce on 2026-08-10:

```
deployer   0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1   nonce = 33

nonce 33 → 0xAcC2CAc2E814F243dbFEAE1B99BcfE1A1A7846Ed   tx1  lane
nonce 34 → 0xf0f3b4a65AD54f1838A581b594CA77A54002c5f1   tx2  A_adapter
nonce 35 → 0xAa9661e983FF3a41c8FE992331E8f1e375d3eE94   tx3  A_pool
```

**These are valid only while the nonce is still 33.** Recompute immediately before tx 1
(`cast nonce <D>` then `cast compute-address <D> --nonce <n>`) and abort if it has moved.
They are recorded here as a worked example of the shape, not as values to paste blindly.

---

## 3b. The fourth transaction: registering the lane on the shared wrapper

Deploying the three contracts is not enough. The lane dispatches through `xcmWrapper`, which
routes by strategy id:

```
strategyAdapter(HYDRATION_USDC_V1) = 0x96091d44…3159    # read from mainnet, the operating lane
```

The pool's lane needs its own entry, via `XcmWrapperV22.setStrategyAdapter`:

```solidity
// XcmWrapperV22.sol:122
function setStrategyAdapter(bytes32 strategyId, address adapter) external onlyOwner {
    if (!dispatchPaused || strategyId == bytes32(0)) revert InvalidConfiguration();
```

Two consequences, and the second is the one to plan around:

1. `onlyOwner` → this is a **multisig** transaction. (Unlike the settler, which needs
   nothing — see §3.)
2. **It requires `dispatchPaused == true`.** The wrapper is *shared* with the live operating
   bank lane, so registering the pool's lane means pausing dispatch on the position that
   currently holds the 10 USDC.

So the ceremony needs a pause window: pause dispatch → `setStrategyAdapter` → unpause.
Schedule it when no operating deployment or recall is in flight — pausing mid-flight is a
different and much less pleasant question. `paused()` on TreasuryPolicy read `false` and
the wrapper's `dispatchPaused` should be read immediately before, not assumed.

This step is what makes the pool's lane *usable*; without it the contracts exist and cannot
dispatch. It is easy to miss because nothing in the three constructors references it.

---

## 4. After deployment: the D-03 gate will refuse until the manifest catches up

The gate now compares live runtime against compiled artifacts by name
(`CONTRACT_ARTIFACTS`, corrected in #1047). Three new deployed contracts mean:

1. Add each to `deployments/mainnet.json` → `contracts`.
2. Add a `contractProvenance` entry per address (`sourceCommit`, `abiHash`,
   `runtimeCodeHash`, `verifiedAt`).
3. Add each to `CONTRACT_ARTIFACTS` in `scripts/ops/check-contract-provenance.mjs`, naming
   the **V22 / actual** source files — the defect #1047 fixed was exactly this mapping going
   stale after a redeployment.
4. Re-run `node scripts/ops/check-contract-source-drift.mjs --profile mainnet --artifacts <out>`
   and require exit 0 before the next production deploy.

Skipping step 3 reproduces today's five-hour freeze.

Note the pool's dedicated lane will be a *second* `HydrationUsdcAdapterV22` deployment.
`CONTRACT_ARTIFACTS` is keyed by manifest contract name, so the two entries map to the same
source file — that is fine, but it means a future source change to that file drifts **both**
and each needs its own reasoning. Do not let one waiver silently cover both addresses.

---

## 5. Epoch-1 accrued yield is NOT booked, and this ceremony does not fix it

The live operating adapter reads:

```
totalAssets  = 10,000,001 raw
totalShares  = 10,000,001 raw     (read 2026-08-10)
```

That is a *recorded book*, written at the last observation, not a live read of the aUSDC
position. On Hydration the aToken rebases continuously; on 2026-08-06 the live balance was
observed climbing 10,000,003 → 10,000,008 while the book stayed at 10,000,001. The
observer-capped accounting (`min(observed, requested)`) is what pins it.

`recordRemotePosition` — the function that reconciles a book to an observed remote position —
was added in #1043 and **the live adapter does not have it**. Proven, not assumed: the live
runtime at 0x96091d44 is byte-identical to `HydrationUsdcAdapterV22` compiled at `3d88391^`,
the commit before #1043.

### "It will come home at recall" is false — verified, not assumed

This was the appealing option, and it does not work. Three facts from the adapter:

```solidity
// _stageWithdraw — a withdraw cannot ask for more than the book holds
if (totalShares < pendingWithdrawalShares + shares) revert InsufficientLiquidity();

// settlement, withdraw branch — the book moves by the REQUESTED amount
totalShares -= request.requestedShares;
totalAssets -= redeemedAssets;

// _recordTerminalAccounting — and observation only ever caps, never raises
uint256 outstanding = observed < requested ? observed : requested;
```

The book only ever moves by what was requested, capped by what was observed. Nothing in the
deposit or withdraw path raises `totalAssets`/`totalShares` toward a larger observed
position. And since a withdraw is bounded by `totalShares` — currently 10,000,001 — the
adapter **cannot request the accrued surplus at all**.

So epoch-1 yield is not merely unbooked. On the live adapter it is **unreachable**: there is
no code path that brings it home. It is not lost — the aUSDC sits with our converted account
and keeps compounding — but it cannot be withdrawn through this adapter.

`recordRemotePosition` is exactly the missing path (`totalAssets = assets; totalShares =
assets;`), and it is the function the live adapter does not have.

### Recommendation: document it, do not chase it

Recovering epoch-1 yield needs the operating lane upgraded to the #1043 runtime, and that is
a real design question rather than a redeploy — the aUSDC is held by a converted account
whose derivation is tied to the current deployment, so a new adapter does not automatically
inherit custody of the residue. That deserves its own packet.

It is not worth doing now:

- At 10 USDC the accrual observed on 2026-08-06 was single-digit raw units per few minutes.
  Four days of that is a fraction of a cent, against a ceremony that would touch a live
  position holding real money.
- The pool's own lane is deployed **with** `recordRemotePosition` from birth, so new money
  does not inherit the problem. This is strictly an epoch-1 artifact.
- The seam matters at scale, not at this size — and the scaling thesis (0.202% friction)
  is what makes larger epochs worth having in the first place.

**What must not happen is someone later assuming the residue comes home on its own.** It
does not. That is the reason this section exists.

Do not quote a current aUSDC figure without measuring the Hydration side. This document
deliberately does not.

---

## 5b. Fork simulation — the ordering is proven, not reasoned

Rerun 2026-08-11 against an `anvil` fork of mainnet at block 19,345,507, deployer nonce 33
(matching mainnet) after the #1066 bytecode change. All four transactions executed:

| tx | contract | address | vs prediction |
|---|---|---|---|
| 1 | `HydrationUsdcAdapterV22` (lane) | `0xAcC2CAc2E814F243dbFEAE1B99BcfE1A1A7846Ed` | **match** |
| 2 | `HydrationDepositPoolAdapter` | `0xf0f3b4a65AD54f1838A581b594CA77A54002c5f1` | **match** |
| 3 | `DepositPool` | `0xAa9661e983FF3a41c8FE992331E8f1e375d3eE94` | **match** |
| 4 | pause → `setStrategyAdapter` → unpause | (multisig owner impersonated) | all `status 0x1` |

Both load-bearing constructor assertions passed for real rather than in argument:
tx2's `lane.agentAccountCore() == address(this)`, and tx3's
`venueAdapter.code.length != 0 && venueAdapter.asset() == asset_ &&
venueAdapter.lossReporter() != address(0)`.

The addresses were recomputed from current state. They are unchanged from the 2026-08-10
run because the deployer nonce is still 33. This is expected: plain CREATE addresses depend
on deployer plus nonce, not creation bytecode. The creation bytecode hashes used in this
rerun were:

```
lane          0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe
venueAdapter  0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44
pool          0xa8f2758ec34ad18defec81b7ea454bf00aa7617981d39575200fa75243628550
```

Wiring read back afterwards — the cycle closes and the live lane is untouched:

```
wrapper.strategyAdapter(HYDRATION_USDC_POOL_V1) = 0xAcC2CAc2…  (new lane)
wrapper.strategyAdapter(HYDRATION_USDC_V1)      = 0x96091d44…  (operating lane, unchanged)
pool.operator()          = 0x5a6836c6…5813
pool.venueAdapter()      = 0xf0f3b4a6…
venueAdapter.pool()      = 0xAa9661e9…
venueAdapter.lane()      = 0xAcC2CAc2…
venueAdapter.lossReporter() = 0x01E6eed8…874C  (TreasuryPolicy owner)
lane.agentAccountCore()  = 0xf0f3b4a6…
lane.strategyId()        = HYDRATION_USDC_POOL_V1
pool.venuePrincipalCostBasis() = 0
```

### What the fork could NOT simulate, and why it does not weaken the result

tx3 first reverted with empty revert data. The cause is not a defect: **USDC at
`0x0000…01200000` is a runtime precompile, not EVM bytecode**, and anvil's EVM does not
implement it. Verified by direct comparison — `decimals()` returns `6` on mainnet and
reverts on the fork, with both reporting essentially no code.

The blocked line is `DepositPool.sol:160`:
`if (IERC20PoolAsset(asset_).decimals() != decimals) revert InvalidAssetDecimals();`
Checked against the real chain instead: mainnet USDC `decimals()` = 6, and the contract's
constant is `uint8 public constant decimals = 6`. It matches, so this passes on mainnet.

To exercise the remaining constructor logic the fork ran with a stub at the USDC address
returning `6` for every call. That stub is why `pool.totalAssets()` reads **6** on the fork:
`balanceOf(pool)` returns 6 while the new cost basis correctly reads 0. The old simulation
read 12 because it also consumed remote managed inventory. On mainnet an empty pool reads 0;
the stub figure is an artifact and must not be carried forward.

**Consequence for future simulations:** an anvil fork cannot model Hub's asset precompile,
so anything touching USDC must be dry-run against a node that implements it — polkadot-js
`dryRunCall` against mainnet state (the technique that caught FIND #19), or chopsticks.
Reach for anvil for pure-EVM wiring, not for anything that moves the asset.

---

## 6. Before anything is signed

- [x] ~~settler address identified~~ — **already satisfied**, `0x5a6836c6…5813` is a
      `strategySettler` and the mapping is global (§3). No multisig needed for this.
- [x] ~~`operator_` shape decided~~ — a dedicated service key, not the multisig; justified by
      the contract's own bounds (§3). The specific key is still Pascal's to name.
- [x] ~~`strategyId_` checked against downstream readers~~ — one non-test consumer,
      a module constant; the hazard was reuse, not choice (§3).
- [x] ~~`operator_` address named~~ — `0x5a6836c6…5813`, the backend signing key (§3),
      with the four-role concentration recorded for the next rotation
- [ ] deployer `D` confirmed quiescent; nonce re-read immediately before tx 1 (§2)
- [ ] predicted addresses **recomputed** at ceremony time — the ones in §3 assume nonce 33
- [x] ~~pause window~~ — the chain is quiet: `pendingDepositAssets = 0`,
      `pendingWithdrawalShares = 0`, `dispatchPaused = false` (read 2026-08-10). Nothing is
      in flight, so the `setStrategyAdapter` pause can be taken whenever the multisig is
      ready. Re-read all three immediately before pausing.
- [x] ~~§5 decision~~ — document, do not chase. "It comes home at recall" was checked and is
      false; recovery needs its own packet and is not worth it at this size.
- [x] ~~dry-run each deployment after #1066~~ — full four-transaction fork simulation reran
      at block 19,345,507 with the new bytecode; all three addresses matched freshly
      recomputed predictions (§5b). The USDC precompile is the one step anvil cannot model;
      its check was verified directly against mainnet instead.
- [ ] caps confirmed as intended: `totalAssets() <= 1_000e6`, `assetsOf(agent) <= 100e6`
- [ ] **on the day**: re-read the deployer nonce and recompute both predicted addresses —
      §5b assumed 33, and the whole ordering depends on it

Nothing here moves depositor money — the pool starts empty. The ceremony's risk is
mis-wiring immutable references, not loss of funds, and every mitigation above targets that.
