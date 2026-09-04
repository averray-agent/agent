# RUNSHEET — Ceremony B, executable: bind a venue to pool v2.1

Status: **READY TO PREPARE — call 5 is IRREVERSIBLE** · 2026-09-03 ·
Author: Claude (architect + gate) · Executor: Pascal (every signature).
Supersedes the sequencing hold in `RUNSHEET_CEREMONY_B_VENUE_BIND.md`: the
measurement it waited for is complete — see
`MEMO_VENUE_ROUND_TRIP_MEASURED.md` (round trip **0.051490**).

## Authority map (verified on-chain 2026-09-03)

| what | who |
|---|---|
| `writeOffVenueLoss` | `adapter.lossReporter()` = **`0x01E6eed856e989201F4FF6346E18EAb7e46C874C`** (2-of-3 treasury multisig) |
| `setDispatchPaused`, `setStrategyAdapter` | wrapper `onlyOwner`; `policy.owner()` = the same multisig |
| `setVenueAdapter` | v2.1 `onlyOwner` — the same multisig |
| lane/adapter deploy | ceremony deployer EOA `0x9Ab8531F…4239` |

**Every privileged call is the multisig.** Only the pair deploy is an EOA.

## Verified state (2026-09-03)

| | |
|---|---|
| legacy v2 `0x6061f0aC…` | total 14.888371, buffer 14.836881, **activeVenueDeploymentId 4**, adapter `0xE2801E6C…` |
| v2.1 `0x9B35A102…` | total **13.460274**, buffer 13.460274, **`venueAdapter() == address(0)`** |
| wrapper `0xF20b35A3…` | `dispatchPaused == false` |
| deployment 4 | principal 4.500000, recalled 4.448510, **0.051490 outstanding** |

## STEP 0 — Write off 0.051490 on deployment 4. Do this regardless.

```
legacy v2 . writeOffVenueLoss(4, 51490)
```

**Why it is not optional:** deployment 4 stays open until principal reconciles,
so the precondition below can never be met while it hangs. It also fixes a live
misstatement — legacy v2 reports `totalAssets 14.888371` while holding
**14.836881** and deploying nothing. **The pool's NAV overstates by exactly the
consumed friction until this is written off.**

This is depositor-impacting by design: it reduces NAV to the truth. The
external depositor's 5.026011 share of a 0.051490 write-down is ≈ 0.0172.

**Gate:** afterwards `activeVenueDeploymentId == 0`, `venuePrincipalCostBasis
== 0`, and `totalAssets == bufferAssets == 14.836881`.

## STEP 1 — Deploy the lane + adapter pair (ceremony deployer EOA)

Mutually immutable constructors, so one address is predicted from the nonce:

1. Predict the deployer's CREATE address at **nonce N+1** (the adapter).
2. Deploy the **lane** at nonce N, passing that predicted address as
   `agentAccountCore_`.
3. Deploy the **adapter** at nonce N+1, passing the *actual* lane address.

Neither contract holds external money at deploy.

**No deploy script exists for this pair.** Build one, or the operator does it by
hand with the nonce pinned. A script is strongly preferred — a hand-run nonce
mistake produces a scrap pair.

## STEP 2 — GATE. Verify the pair before any signature.

```
adapter.lane()              == <deployed lane>
lane.agentAccountCore()     == <deployed adapter>
adapter.pool()              == 0x9B35A102…   (v2.1, NOT legacy)
adapter.asset()             == 0x0000053900000000000000000000000001200000
adapter.lossReporter()      != address(0)
```

**If any check fails, the pair is scrap. Redeploy — never bind a pair that did
not verify.** The legacy adapter `0xE2801E6C…` reads `pool() = 0x6061f0aC…`
and is permanently bound there; it cannot be reused.

## STEP 3 — Preconditions for pausing dispatch

- both pools `activeVenueDeploymentId == 0` and `activeVenueRecallId == 0`
- wrapper has no unsettled request
- **pausing halts ALL XCM dispatch** — keep the window minutes, not hours

## STEP 4 — The signing session (multisig)

| # | call | note |
|---|---|---|
| 1 | `wrapper.setDispatchPaused(true)` | required precondition for 2 |
| 2 | `wrapper.setStrategyAdapter(AAC_IDLE_HYDRATION_V1, <lane>)` | register the lane |
| 3 | `wrapper.setDispatchPaused(false)` | restore dispatch |
| 4 | `v2.1.setVenueAdapter(<adapter>)` | **SET-ONCE, PERMANENT** |

Keep 1–3 in one session. Leave `HYDRATION_USDC_POOL_V1` registered — legacy v2
still holds the tester's 5.026011 and needs its recall path.

## Call 4 is irreversible — the standing warning

`setVenueAdapter` is set-once. Whatever binds to v2.1 is permanent; a future
venue change means a **new pool**, not another setter call.

**What we know, stated plainly before signing:** one round trip, measured once
in each direction. Entry 0.050000, exit 0.001490 — a 33× asymmetry that is
**unexplained**. 4.5 USDC is small, and flat friction at 25–100 USDC is
unproven. Break-even at 13.460274 held: **30-day and 90-day clear; 7-day does
not** (needs 23.76).

Pascal authorised proceeding on 2026-09-03 with these caveats on the record.

## After binding — what is still NOT true

Binding an adapter does not make deposits earn. It makes them *able* to earn.
Yield needs a deployment, and `deployToVenue` still caps at `NOTICE_7_DAYS`,
whose break-even (23.76) exceeds what v2.1 holds. **Expect the honest page copy
to stay "not yet earning" until either the pool grows ~10 USDC or v2.2 allows
longer windows.**

## Abort conditions

Stop and reassess if: the pair fails any STEP 2 check; either pool shows an
active deployment or recall; the wrapper has an unsettled request; or the
write-off in STEP 0 does not reconcile to `totalAssets == bufferAssets`.

## Handback

Write-off tx; both deploy txs with the predicted-vs-actual addresses; the STEP 2
verification output; the four call hashes; and a post-state read of v2.1
`venueAdapter()`.
