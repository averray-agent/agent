# Pool v2.1 — measurement cycle 2 (record)

Purpose: resolve the venue-rate ambiguity (gate basis 4.9 %/yr vs cycle-1 record ~19 %/yr).
Operator-subsidised; not a yield cycle; no rate is quoted from it externally.
Executor: Pascal (KMS signer 0x5a6836…, inside `agent-mainnet-backend`). Gate: Claude.

## Deployment (Asset Hub, pool v2.1 `0x9B35A102…`)

| step | tx | block | time (UTC) | facts |
|---|---|---|---|---|
| `deployToVenue(10243759, 1790135406)` | `0x376573c27cc6ee95b1c9c3c539df2159fc9ae8d43bcb8836330fcd53d579b0d0` | 20708505 | 2026-09-16 07:50:48 | deployment **2**, kind `standing`, returnBy **2026-09-23T03:50:06Z**, adapter request `0x85dd567d7dcec5750022c4738e31ce0d3f85a8c8d44599f363a574404c94b45d`; policy fraction after 49.99 % |
| stage (lane request `0x1badcfff308b655e4710bdfcfd606dcca3478c300529494637265be71a2eefe1`, strategy `AAC_IDLE_HYDRATION_V1`) | `0x96bce805c6…` | 20708616 | 07:54:24 | fee envelope 40k/leg, float 50k; sell amount 10,193,759 |
| `deposit_funding` | `0x8111bfd2ac…` | 20708620 | 07:54:24 | XCM sent |
| `deposit_sell` | `0x19a67128a4…` | 20708621 | 07:55:12 | XCM sent |
| lane `settleRequest` (Succeeded) | `0xc1c0d98437…` | 20714840 | 11:41:12 | settledAssets **10,193,881** (10,193,759 minted + 122 accrued to the settlement block); via the #1386 historical observation after the original process died |
| pool `settleVenueDeployment(2)` | `0x68e52359511bf9762240f64815725a41e881c01c8bbfb2b0434e8326cf145ded` | 20714934 | 11:44:00 | deployment 2 status **Succeeded**; the CLI's receipt wait timed out (VPS RPC) but the tx had landed — verified by state before any retry |

## Far side (Hydration, venue account `12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4` = H160 `0x48df881b65e682f05ac24dc8f668a8938225e973`)

| event | block | time | facts |
|---|---|---|---|
| funding deposited | 14663113 | 07:55:06 | 10,243,206 USDC (funding fee **553**) |
| AAVE par swap `Swapped3` | 14663125 | 07:55:36 | 10,193,759 USDC → **10,193,759 aUSDC** (exact par), 18,384 refunded to float |
| balances at t₀ | 14663125 | 07:55:36 | aUSDC 10.211216 (= this cycle 10.193759 + cycle-1 parked 0.017457); USDC float 1.563465 |
| at lane settlement | 14669104 | 11:41 | aUSDC 10.211321 (+105 raw on the whole position ≈ +122 on the cycle's tranche per the settlement proof) |

## Entry friction (reconciled to the raw unit)

funding fee 553 + sell execution fee 18,604 (net of the 18,384 refund) = **19,157 raw = 0.019157 USDC**
(cycle 1: 0.021702). Float parked on Hydration for this cycle: 30,842 raw
(recoverable). Committed 10,243,759 = 10,193,759 aUSDC + 30,842 float +
553 + 18,604 ✓.

## t₀ for the rate

**10,193,759 aUSDC at 2026-09-16 07:55:36Z** (the cycle's tranche; read the
whole-account aUSDC and subtract the 17,457 parked from cycle 1, which
accrues too — or, simpler, use the whole-account figure 10,211,216 at t₀ and
compare whole-account readings).

`rate = (aUSDC_now − aUSDC_t0) / aUSDC_t0 × 365 / days`

| reading | due | aUSDC (whole account) | Δ raw | annualised |
|---|---|---|---|---|
| t₀ | 2026-09-16 07:55:36Z | 10,211,216 | — | — |
| day 4 (day-3 slot, taken late) | 2026-09-20 09:17:36Z (Hydration 14821890) | 10,214,220 | +3,004 | **2.647 %** (whole account, 4.057 d) |
| day 3 | 2026-09-19 | | | |
| day 6 (before recall) | 2026-09-21 13:50:00Z (Hydration 14868957) | 10,215,062 | +3,846 | **2.621 %** (5.246 d) |

## Recall (day 6 — 2026-09-22, before returnBy 09-23 03:50Z)

`pool-venue-ceremony.mjs recall --deployment-id 2 --assets <whole far-side aUSDC>` → `stage-recall --recall-id 2`
→ `settle --recall-id 2`; each dry-run then commit. Recall the whole position
including accrued interest (the runsheet's rule). Exit friction and round-trip
friction recorded here; then the subsidy attestation on `/pool`.

## Incidents during this cycle

1. The original `stage-dispatch --commit` process died after the sell leg
   (backend RPC saturation, #1384) and the resume path could not observe an
   already-executed swap → fixed by #1386 (historical observation), deployed
   11:23Z, resumed 11:41Z. Nothing was repeated; no funds at risk at any point.
2. The pool `settle --commit` reported `wait for transaction timeout` after
   broadcasting; the tx had landed (blk 20714934). Rule: read chain state
   before any retry; a retry would have reverted harmlessly but wasted gas.

## Recall — 2026-09-21 (attempt 1)

- `recall --assets 10215062` refused: `VenueRecallExceedsManaged(10193881, 10215062)` — the adapter manages 10,193,881; recalled the managed amount, 21,181 raw stays parked (interest + cycle-1 remainder).
- **Recall id 2** requested: tx `0x0bcb9d4bb593ea161fa92f728632cdf739f8c79312597c323aabe55a1f95cd89`, block 20915725, 14:04:48Z, fee 0.0289792 DOT (driver reported a wait timeout; tx had landed — same pattern as the settle on 09-16).
- `stage-recall --commit` at 14:40Z: adapter tx `0x076c3f48…` (nonce 2809), lane tx `0x8e4c91fe…` (2810), wrapper dispatch `0x4b5dea32…` (2811); lane request `0x7fa1e25d…ff1385`, adapter request `0x78db2e49…c31d`, bitmap 4.
- Hydration block 14870297 (14:40:48Z): message processed `success: true`, fee 21,657 raw USDC(22) net, **no sell** — `Transact(router.sell)` failed silently inside a successful message. Venue aUSDC untouched (10.215135 at 16:19Z). Driver exited: `Timed out without request-bound Broadcast.Swapped evidence`.
- Replays of the identical wire bytes via `DryRunApi`: 1 silent failure in 6, then 16/16 executed at exact par. Intermittent, block-dependent, cause not identified. Packet: `PACKET_RECALL_SELL_LEG_SILENTLY_NOT_EXECUTED.md`.
- State at end of day: pool activeRecall 2 / activeDeployment 2, lane pendingWithdrawalShares 10,193,881, wrapper request Pending bitmap 4; all funds intact and accruing at Hydration; returnBy 09-23 03:50Z is soft for v2.1 (write-off is loss-reporter-only).
