# Ceremony — bringing the agent deposit pool live on mainnet

Status: **written, not executed.** Nothing in this document has been run.

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
| `strategyId_` | **DECIDE** — must NOT be `HYDRATION_USDC_V1` | see below |
| `agentAccountCore_` | `A_adapter` (predicted) | immutable |
| `operator_` (pool) | **DECIDE** | see below |

### `strategyId_` must be new

`HYDRATION_USDC_V1` is already bound to the operating adapter 0x96091d44 in the manifest's
`strategies` block. The pool's lane is a *separate* deployment with its own book; reusing
the id would conflate two positions in every downstream read — exactly the kind of thing
that makes a money view lie. Propose `HYDRATION_USDC_POOL_V1`, and check whether anything
keys off the id before committing to the string.

### `operator_` — open, and it is a real decision

The pool's `operator` governs venue deployment and recall. It should not be a key that also
does routine ops. Candidates: the multisig owner `0x01e6eed8…874c`, or a dedicated
service operator. **Not decided here** — it is a durable authority assignment and belongs to
Pascal.

### Authorisation the lane needs

`HydrationUsdcAdapterV22.onlyOperator` resolves to `policy.strategySettler(msg.sender)`
(`:101`), and owner-only paths check `policy.owner()` (`:111`). So after deployment the new
lane needs its settler registered on TreasuryPolicy, the same shape as the
`setServiceOperator` ceremony that unblocked the worker loop previously. **Verify which
address must be the settler for the pool lane before the ceremony**, because discovering it
afterwards means another multisig round trip.

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

So the yield is accruing off-book on an adapter that has no way to book it. Options, none
chosen here:

- **Leave it, book at recall.** The aUSDC is genuinely held by our converted account; a
  recall observes the actual balance, so the surplus should come home at settlement and the
  books catch up then. This makes it an accounting lag rather than a loss — **but the recall
  path returning the full rebased balance has not been verified end to end at this scale,
  and it should be before it is relied on.**
- **Redeploy the operating adapter** with the #1043 runtime. Correct long-term, but it moves
  a live position holding real money and is a much larger ceremony than the pool deployment.
- **Accept and document** the seam until the next epoch, deploying epoch 2 onto a lane that
  has `recordRemotePosition` from birth.

The pool's own lane will be deployed *with* `recordRemotePosition`, so this problem does not
propagate forward. It is specifically an epoch-1 artifact.

Do not quote a current aUSDC figure without measuring the Hydration side. This document
deliberately does not.

---

## 6. Before anything is signed

- [ ] `operator_` decided (§3)
- [ ] `strategyId_` string decided and checked against downstream readers (§3)
- [ ] settler address for the new lane identified (§3)
- [ ] deployer `D` confirmed quiescent; nonce read immediately before tx 1 (§2)
- [ ] both predicted addresses computed and recorded, to be re-checked after each tx (§2)
- [ ] dry-run each deployment against current state before broadcasting
- [ ] caps confirmed as intended: `totalAssets() <= 1_000e6`, `assetsOf(agent) <= 100e6`
- [ ] a decision recorded for §5, even if the decision is "leave it and document"

Nothing here moves depositor money — the pool starts empty. The ceremony's risk is
mis-wiring immutable references, not loss of funds, and every mitigation above targets that.
