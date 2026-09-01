# RUNSHEET — Recall deployment 4 now (measure exit friction)

Status: **READY TO EXECUTE** · 2026-08-30 · Operator: Pascal ·
Authorised by Pascal 2026-08-30 ("recall and start now"), ahead of the
2026-09-04 deadline.

## Verified state (read live before writing this)

| field | value |
|---|---|
| pool (legacy v2) | `0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30` |
| deploymentId | **4** |
| activeRecallId | **0** — nothing in flight, clean start |
| adapter | `0xE2801E6C640e0180798912649fD567E1Ea459a35` |
| principalAssets | **4.500000** (what left the pool) |
| recalledPrincipalAssets | 0.000000 |
| returnBy | 2026-09-04T16:25:12Z |
| venue holds (platform read) | **4.465275** total aUSDC, incl. **0.014738** pre-existing from the earlier epoch |
| pool operator (the signer) | `0x5a6836c6D4d293F6E5377E6c28054F4171915813` |

**Single-signer, KMS via Roles Anywhere. No multisig.** Must run **inside the
backend container** — Roles Anywhere does not resolve outside it.

## Why now, on the record

Earned to date **0.001674 USDC** against **0.022464** entry friction already
paid. Holding to 2026-09-04 yields **0.006888** total — 31% of entry cost.
At 4.5 deployed this position **cannot** reach break-even (that needs 13–20
deployable). It was always a measurement, not an investment. The exit number is
worth far more than the remaining 0.005 USDC of accrual.

## Step 1 — DRY RUN the recall request. Do not pass `--commit`.

```
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs recall \
  --profile mainnet \
  --pool 0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30 \
  --deployment-id 4 \
  --assets 4450000 \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --use-kms
```

`--assets` is **raw 6-decimal units**: `4450000` = 4.450000 USDC.

**Why 4450000 and not 4500000:** the pool's recorded principal is 4.5, but only
~4.4505 is actually at the venue — entry friction consumed the difference.
Requesting cost basis is the known trap. This value is deliberately just under
the venue balance.

**Expected:** a green static call reporting a recallId.
**`JsonRpcProvider failed to detect network … retry in 1s` is BENIGN** — a green
dry run emits it many times. Read the OUTPUT, never the exit code.

**If it reverts:** stop and report the revert reason. Do not raise `--assets`.
Step down (e.g. `4440000`) only after reading the reason.

## Step 2 — COMMIT the recall request

Same command **plus `--commit`**. Record the returned **recallId** and tx hash.

## Step 3 — DRY RUN the settle

```
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs settle \
  --profile mainnet \
  --pool 0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30 \
  --recall-id <RECALL_ID_FROM_STEP_2> \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --use-kms
```

The XCM return leg may need time to arrive. If settle reports nothing returned
yet, **wait and retry** — do not re-request the recall.

## Step 4 — COMMIT the settle

Same plus `--commit`. Record **returnedAssets** and the tx hash.

## Step 5 — The measurement (the entire point)

Record, and hand back:

```
principal that left the pool      4.500000
aUSDC that reached the venue      4.450000       (entry friction 0.022464 + rounding)
venue balance before recall       ______         (minus 0.014738 pre-existing)
returnedAssets to the pool        ______
accrued while deployed            ______
EXIT FRICTION                     ______   <-- the number we came for
ROUND TRIP  = 0.022464 + exit     ______
```

Then compare against `docs/MEMO_SEPT4_DECISION_TREE.md`, whose thresholds were
fixed **before** this data existed:

- round trip ≤ 0.0325 → **scale path**, shelve v2.2
- round trip ≈ 0.107+ → entry was the outlier, v2.2 is the only route
- between → neither immediately, and say so

## What must NOT happen

- Do not raise `--assets` past the venue balance to "get it all".
- Do not re-request while a recall is in flight (`activeVenueRecallId != 0`).
- Do not redeploy on legacy afterwards: `DEPLOYMENT_EPOCH = 1 days`, and
  deployment 4 was created ~13:00Z today.
- Do not bind a venue to v2.1 in the same session. That is Ceremony B, it is
  **owner-gated (2-of-3 multisig)**, and it comes after the measurement is read.
