# RUNSHEET v2 — Venue recall, deployment 3

Status: **READY** · Rewritten 2026-08-25 · Author: Claude (architect + gate) ·
Executor: Pascal (every money step) · Deadline: **2026-08-28T16:48Z**

**Supersedes `RUNSHEET_AUG28_RECALL.md`, which must not be executed.** Its
premise was that a lane request stood staged and pending, needing only a
dispatch. Step 0 disproved that on 2026-08-25: the request it named,
`0xe1029b10…`, maps to pool request `0xd88a7b3b…`, which is **venueRecall[4],
already settled against deployment 2** (requested 4.950004, returned
4.948243). Scanning recall indices 0–19, **no recall references deployment 3
at all.** Nothing was staged. This is a `stage-recall`, not a dispatch.

## Decisions — RATIFIED (Pascal, 2026-08-25)

**D1 — Write-off timing: after the recall, inside reconciliation.** One
multisig session against the true realised number. The recall's actual return
carries exit friction and XCM fees on top of the 0.100000, so booking
afterwards writes off the real total once instead of guessing now and topping
up later. The deposit gate (#1287) is live, so the stale price cannot reach a
new depositor in the interim — that is what removed the urgency.

**D2 — Make the depositor whole: yes, 0.024764 USDC, paid after the recall.**
Our own adapter reported the 9.400000 gap on Asset Hub in the block *before*
their deposit, so "we could not know" is not available to us.

**D3 — Do not redeploy.** Entry friction is 1.053% of principal against
~0.0029/day accrual (≈11.3% APY): break-even needs a **35.5-day** epoch and
this one ran **8.2**, coming out 4.3× wash-negative. The venue is fine; the
epoch is too short. Cost basis goes to zero, the gate self-disarms, and the
lane stays idle until consented locked capital can fund a real epoch. Any
future deployment is a fresh decision that must clear the 35.5-day bar.

## Established state (all verified live 2026-08-25)

| fact | value | source |
|---|---|---|
| deployment 3 principal | 9.500000 | `venueDeployments(3)` |
| recalled so far | 0.000000 | `venueDeployments(3)` |
| **returnBy** | **2026-08-28T16:48Z** | `venueDeployments(3)` |
| adapter reports landed | 9.400000 | `venueAdapter.managedAssets(pool)` |
| actual aUSDC at venue | 9.414667 | Hydration ERC-20 `balanceOf` |
| loose USDC at venue | 1.546422 | Hydration `tokens.accounts(acct, 22)` |
| **venue DOT postage** | **0.510000** | **Asset Hub** `system.account` (see below) |
| pool totalAssets | 25.395226 | `poolV2.totalAssets()` |
| quoted fee | ~27,952 | `quoteRemoteFee` |

The gap decomposes with **opposite signs**, and this matters for what gets
written off: `9.500000 → 9.400000` is **−0.100000 of certain, already-realised
XCM/swap entry friction**, while `9.400000 → 9.414667` is **+0.014667 of
unrealised venue accrual**. Net −0.085333. Only the first is a write-off.

## Postage — verified clear, no funding needed

`stage-recall` enforces `MIN_VENUE_POSTAGE_PLANCK = 500_000_000` (0.05 DOT).
**Read live 2026-08-25: 0.510000 DOT — 10.2× the floor. Nothing to fund.**

Read the *right* account, because two plausible wrong ones exist. Per
`pool-venue-dispatch.mjs:1058`, postage is:

```
ledger  : substrate_system (native DOT)
chain   : ASSET HUB              <- not Hydration
account : venueAddress || 0xEE * 12   <- the ADAPTER contract, EVM-derived
        = 0xe2801e6c640e0180798912649fd567e1ea459a35eeeeeeeeeeeeeeeeeeeeeeee
SS58    = 167yt7KXEjXLrZhVcwhaPv8Z7KEVMgsnzizB7yg1PANPxf53
```

The script's other far-side targets (`float`, `position`) *are* the Hydration
converted account `0x48df881b…91e7f3`, which is why postage looks like it
should be too. It is not. Reading DOT there returns 0 and produces a false
blocker; that mistake was made and corrected while writing this runsheet.
If postage ever does need topping up, it is a **DOT transfer on Asset Hub**
to the SS58 above — never a Hydration transfer.

## The fee window is open — the old watcher was measuring the wrong cap

`scratch-fee-watch.mjs` tests the quote against "≤26,000 for the 40k cap".
That 40,000 is `DEFAULT_DEPLOY_MAX_FEE_PER_LEG_RAW` — the **deploy** ceiling,
inherited from the staged artifact that turned out to be deployment-side.

`stage-recall` defaults to `MAX_FEE_PER_LEG_RAW = 80_000` with
`DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS = 15_000` (150%), so the recall threshold
is **≈53,333**, not 26,000. At ~27,952 the window is open with roughly 2×
headroom. Do not raise any cap to make a number fit; if the quote ever exceeds
53,333, wait.

## Ceremony

### 0 · Establish state (read-only, no signatures)

Run `status` and confirm it agrees with the table above:

```
node scripts/ops/pool-venue-dispatch.mjs status --profile mainnet \
  --deployment-id 3 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --asset-hub-ws wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --hydration-ws wss://hydration-rpc.n.dwellir.com \
  --hydration-evm-rpc https://rpc.hydradx.cloud \
  --observability-url http://127.0.0.1:18787/monitor/deposit-pool
```

The observability endpoint is VPS-internal — run on the VPS, or tunnel with
`ssh -N -L 18787:127.0.0.1:18787 ubuntu@141.94.121.188`.

**Gate:** paste the output. Any material disagreement with the table stops the
ceremony.

### 1 · Confirm postage (read-only)

Already verified clear at 0.510000 DOT. `status` re-reads it; confirm the
plan's `postage.raw` is at or above 500000000. No transfer is expected.

### 2 · Stage the recall (dry-run first)

`stage-recall` against **deployment 3**, taking the 80k/150% defaults. Dry-run
is the default; `--commit --use-kms` is required to write, and raw keys are
never accepted.

**Gate:** I check the derived recall parameters — share count, `minimumOutput`,
`maxFeePerLeg`, deadline — before you add `--commit`.

### 3 · Dispatch, then confirm arrival on both sides

Funds return asynchronously. Confirm the Hydration side **falling** and the
Asset Hub side **rising**. Two-sided confirmation is the rule; a single-sided
read has misled us before. Then finalise.

**Gate:** paste both balance reads.

### 4 · Book the loss (multisig)

`writeOffVenueLoss(3, 100000)` — 0.100000 USDC, the certain entry friction,
**not** the 0.085333 net. Authority is `venueAdapter.lossReporter()` =
`0x01E6eed8…874C`, verified as the 2-of-3 treasury multisig (SS58
`14LA8vJD…Kc3YK`, mapped, funded 8.04 DOT ≈ 804× ED).

Measure weight via `reviveApi.call().weightRequired` first — epoch 1 needed
proofSize 242,216.

**Multisig law in full:** I precompute the `blake2AsHex` call hash; you confirm
Nova displays *exactly* that hash before the Vault signs.

**Gate:** I verify the encoded call and hash before the first signature.

### 5 · Reconcile and stop

Confirm `venuePrincipalCostBasis()` reads 0. At zero the deposit gate (#1287)
goes inert automatically and re-arms next epoch — no action needed.

Pay `0x97450BF6…4b5c` **0.024764 USDC** per **D2**. Record the tx hash beside
the reconciliation evidence.

Per **D3** the lane now stays idle. Do not stage a new deployment.

## Abort conditions (any one ⇒ stop and report)

- `status` disagrees materially with the established-state table.
- Plan `postage.raw` below 500000000 (0.05 DOT) on Asset Hub.
- Quoted fee exceeds 53,333 — wait; never raise the cap to fit.
- Arrival confirmed on only one side.
- Realised loss materially exceeds 0.100000 plus XCM fees.
- Nova shows any hash other than the one I precomputed.

## What this runsheet does not do

Redeploy, touch the locked cohort, change the activation gate or per-wallet
cap, or alter consent text. It ends with the venue position closed and the
lane idle.
