# Ceremony runsheet — Pool v2 yield epoch 2 (+ v1 lane recall)

- **Status:** NOT SCHEDULED. This file exists so the **v1 lane recall (§A) cannot
  be lost**; that leg is fully decided. The epoch-2 yield legs (§B) stay
  deliberately unset until the epoch is scheduled — inventing deployment sizes
  ahead of the decision is how a runsheet starts lying.
- **Operator:** Pascal signs. **Gate:** Claude, between every leg.
- **Signer:** KMS only —
  `--commit --use-kms --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813`.
  The scripts never accept a raw key.
- **Inherits:** the epoch-1 reconciliation standard (`CEREMONY_POOLV2_YIELD_EPOCH1.md` §3)
  — the ledger closes to zero unexplained raw units, or the leg does not pass.

---

## §A — Recall the v1 Hydration lane · DECIDED 2026-08-18 (Pascal)

### Why this rides along rather than getting its own ceremony

The position is **10.000001 USDC**, earning ~5% — about fifty cents a year. That
does not justify a standalone signing session, a bespoke driver and ~1 DOT of
gas. It does justify one extra leg on a ceremony already going to the same
venue with the same signer.

### What was established (2026-08-18, all read live)

| Fact | Value | How |
| --- | --- | --- |
| v1 adapter | `0x96091d4477Fe37E79557276d63883bBbbdE73159` | `XcmWrapper.strategyAdapter(HYDRATION_USDC_V1)` |
| v1 reports | **10.000001 USDC** | `adapter.totalAssets()` |
| Pool lane reports | 4.950004 USDC | `adapter.totalAssets()` |
| **Actually at Hydration** | **14.960236 aUSDC** | `aHydratedUSDC 0x2ec4884088d84e5c2970a034732e5209b0acfa93` on `rpc.hydradx.cloud` (chain 222222), holder `0x48DF881b65E682f05ac24DC8f668A8938225E973` |
| Unbooked accrual | +0.010231 | venue − adapter sum |

**The accrual implies 5.00% APY over ~5 days.** That exact match is what proves
both positions are live rather than stale accounting. Neither adapter holds any
USDC on Hub — correct for XCM positions, and precisely why Hub-only reads could
never settle this. **Always confirm venue-side.**

**It is operator capital, not depositor capital.** The DepositPool books close
without it: idle 15.446982 + deployed 5.000000 = totalAssets 20.446982, exact.
Had it been pool capital, the share price would have been understating what
depositors are owed — it was not.

### Preconditions (gate before ceremony day)

1. **Recall path confirmed on the v1 adapter.** `withdraw()` reverts
   `AsyncOnly()` by design; the exit is async:
   `stageTreasuryWithdraw` → dispatch → observe at Hydration →
   `settleRequest` / `releaseRecoveredAssets`. **No driver exists** —
   `pool-venue-ceremony.mjs` and `pool-venue-dispatch.mjs` are pool-lane only.
   Build the v1 leg or extend the existing driver; dry-run before ceremony day.
2. Fresh venue read: aUSDC balance and both adapters' `totalAssets`, recorded
   immediately before the leg so the reconciliation has a true opening balance.
3. Reward-bank destination confirmed: KMS signer `0x5a6836…5813` AAC liquid.

### The leg

Dry-run → **Claude gates** → `--commit`. Gates on completion:

- v1 `adapter.totalAssets()` → **0**.
- aUSDC at Hydration falls by the recalled amount **plus** its share of accrual;
  the pool lane's position is **untouched** — this is the assertion that proves
  we recalled the right lane.
- Proceeds land in the reward bank; `AAC.positions(0x5a6836…, USDC).liquid`
  rises by exactly the released amount.
- Ledger closes to zero unexplained raw units (epoch-1 standard): released =
  principal + accrual − transfer fee − remote exec fee, refund tail accounted.

### Honesty rules for this leg

- **Operator capital returning to operator use.** It is never protocol revenue,
  never an external-verified-outcome, and never appears on the transparency page.
- Accrued yield is **operator yield on operator capital** — not depositor yield,
  and it must not touch the pool share price.
- If recall proves blocked or disproportionately expensive, the ratified
  fallback is to **approve v1 in §8 as a deliberate second position** and say so
  plainly — not to leave an unapproved lane quietly holding money.

### Follow-through (after the leg lands)

- **§8 multisig:** approve **only** the pool lane; deregister v1 from the
  wrapper. Today both adapters read `approvedStrategies = false` while holding
  real capital — that is the gap this closes.
- **Board:** capital-at-work must sum **all registered lanes**, not just the
  pool derivation (#1167 shipped the pool half). After recall v1 reads 0, but
  the summing bug is real and outlives this ceremony.
- Record both positions' closing numbers in memory.

---

## §B EXECUTED 2026-08-20/21 — full record (roll: recall 5.0 → write-off → deploy 9.5)

**Deployed 9.5 USDC earning at the venue; pool NAV honest at 20.395225; every raw unit named.**

| step | evidence |
| --- | --- |
| recall 4 staged (KMS) | `0x13d71db1…` — full 4.950004 incl. yield |
| keeper gap found | the backend NEVER dispatches ceremony-staged requests — venue-side read (aUSDC unmoved) proved it; the §A-class driver `pool-venue-dispatch.mjs` is the dispatch path |
| fee-guard amendment | Hydration withdraw-sell quote FLAT 28.6k > old 40k cap's 1.5x floor; #1191 (ratified by merge): recall ceiling 80k + `--fee-floor-ratio-bps` (hard min 13,500) |
| recall dispatched @1.40x margin | sell `0xa5216924…` exact par 4,950,004 (fee 40k capped, actual 28,722 paid from float); home `0x68ba90dc…` arrival 4,948,243 (fees 1,761); auto-settled `0x6cdbf831…` |
| pool settle | `0xaf4854bb…` — idle +4.948243 exact |
| write-off 51,757 (MULTISIG — lossReporter by design) | Nova `revive.call` hash `0x77bd56f1…9efbe3`, executed 21 Aug 18:54; decomposed: 49,996 epoch-1 cost-basis gap + 1,761 recall fees; sharePrice -> 0.994824 (depositor-honest NAV) |
| deploy 9.5 staged (KMS) | `0x7c9d98e9…` — E2-4 checks all true (value-neutral staging) |
| deposit legs dispatched | stage `0xdd10d1a8…`; funding `0x652969ad…` (arrival 9,499,155); sell `0x36773f49…` 9.4 -> 9.4 aUSDC EXACT PAR (fee 56,708 = quote x2, under the 80k cap); auto-settle `0xab2dfeab…` |
| venue verified | aUSDC 9,411,876 (9.4M position + 11,876 residue) · float 1,546,422 · returnBy 2026-08-28T16:48Z |

**Fee ledger (roll total ~0.060 USDC):** recall 30,483 raw (28,722 float-paid + 1,761 principal-path) + deploy 29,368 raw (845 delivery + 28,523 sell).

**ECONOMICS CORRECTION (2026-08-21, supersedes the memo's E2-3 amendment):** measured
roll cost is FLAT ~0.060/roll, not the 0.202% proportional figure the memo assumed.
At 9.5 deployed and ~5% APY, weekly yield is 0.0090 vs 0.0599 cost — the weekly roll
is 6.6x WASH-NEGATIVE at this size. Break-even deployed size ≈ 62 USDC weekly, or
~15 USDC if a 30-day tier existed (the enum exists; deployToVenue hardcodes 7d).
**Decision needed before the Aug 28 returnBy:** recall-and-pause the strategy until
TVL scale or a 30-day-tier contract amendment, rather than knowingly rolling at a loss.

**Laws banked:** ceremony-staged adapter requests need MANUAL driver dispatch (the keeper never picks them up — verify venue-side, not by waiting) · measure revive weights per call (write-off measured proofSize 242,216 vs the library's pinned 100k) · a native multisig's AccountId32 comes from `revive.originalAccount`, NEVER 0xEE-padding · depositor-impacting write-offs are lossReporter=multisig BY DESIGN.

**Next roll due by 2026-08-28T16:48Z** (weekly cadence per amended E2-3; keeper automation of the roll = open authority decision).

Standing constraint from the bank lane: if a DepositPool window is near, fold
epoch-2 into post-migration rather than deploying venue capital the migration
must first recall.

## §C — Abort table

| Failure | State | Action |
| --- | --- | --- |
| v1 stage reverts | nothing moved | Stop; the driver is wrong, not the chain |
| Dispatch sent, no remote observation | funds in flight | Do **not** retry; wait the timeout, then the recovery path (`releaseRecoveredAssets`) |
| Recalled amount ≠ venue delta | reconciliation broken | Stop and reconcile before any further leg — this is the epoch-1 bar |
| Pool lane position moved | **wrong lane touched** | Stop immediately, capture evidence, page Claude |

Last row is the only incident. Everything else is the async design behaving.


---

# §A EXECUTED — 2026-08-19 → 2026-08-20

**The 10 USDC is home. Ledger closes to zero unexplained raw units.**

| Leg | What | Evidence |
| --- | --- | --- |
| A (multisig) | staged all 10,000,001 shares | second §8 operation, hash `0x33950729…`, blk 19647240 (first two attempts died on under-measured **proofSize** — 100k, then 116.8k vs measured 884,341; the law is now measured-per-call) |
| B (KMS) | dispatch → par sale at Hydration → home → **auto-settle on arrival** | wrapper emissions blks 19649996/19650009; adapter settle event blk 19650022 = **9,998,432**; the driver's manual settle phase was preempted by the adapter's auto-settle — completion evidence reconstructed FROM CHAIN, then Leg C's builder re-verified the arrival against live balances anyway |
| C (multisig) | transfer exact arrival → KMS signer | hash `0x4b3407c7…`, executed 2026-08-20 08:17, multisig closed at its exact opening 0.878804 |
| D (KMS) | deposit → reward bank | txs `0xe09b84f3…`/`0xc87af0ac…` blks 19672968/70 |

**Reconciliation:** sold 10,000,001 aUSDC at exact par (quote and fill identical) →
arrived 9,998,432 → in-flight cost **1,569 raw (0.0016 USDC)** → transferred and
deposited **exactly**. Venue residual 11,140 stays at the deployment account
(accrual + fee refund — operator yield on operator capital). Pool lane
**untouched throughout**: 4,950,004 backing intact. Reward bank
10.775090 → **20.773522**. EOA back to 0.01 dust, allowances all zero, multisig
at its opening. v1 book: **0**.

**Remaining cleanliness (one small Nova call, any future session):**
`XcmWrapper.setStrategyAdapter(HYDRATION_USDC_V1, 0x0)` — deregister the empty
v1 lane so the treasury posture reads Green rather than carrying a
registered-but-unapproved zero-balance row.
