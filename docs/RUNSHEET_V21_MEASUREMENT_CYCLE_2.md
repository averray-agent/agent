# RUNSHEET — v2.1 measurement cycle 2 (7-day, operator-subsidised, for the rate — not for earning)

Status: ready to execute · decided 2026-09-16 (Pascal) · executor: Pascal on the
VPS, inside `agent-mainnet-backend` (KMS signer, no multisig) · same shape as
cycle 1 (2026-09-05 → 09-08).

## Why this cycle exists

Our two venue-rate observations disagree four-fold: the activation gate's basis
(0.009 on 9.5 over 7 d ≈ 4.9 %/yr) and cycle 1's own record (0.01743 accrued
over 3.4 d on 9.93 ≈ 19 %/yr). Every v2.2 number scales off this. A 7-day cycle
at the policy size costs ≈0.02–0.04 net (friction 0.052 minus 7 days of yield),
disclosed on `/pool` as operator-added like cycle 1. **It is a measurement; it
will not earn.** Nothing is quoted from it externally — two cycles give a
range, not a rate.

## Preconditions — read 2026-09-16 09:40Z, RE-READ before commit

| | read | required |
|---|---|---|
| `activeVenueDeploymentId` / `activeVenueRecallId` | 0 / 0 | both 0 |
| `lastDeploymentEpochAt` | 2026-09-05 10:52Z | > 24 h ago ✓ |
| `totalAssets` / `bufferFloor` / `maxDeployableAssets` | 20.487519 / 10.180516 / 10.307003 | — |
| **50 % policy max** `floor(totalAssets/2) − costBasis` | **10.243759** | size `--assets` from THIS, not from `maxDeployableAssets` |
| wrapper `dispatchPaused` | false | false |
| adapter `0x0e3929F1…` DOT postage | 1.5 DOT | ≥ 0.5 |
| backend deployedSha | c842f59b+ (#1342 lane-strategy fix in) | — |

A deposit, redemption or write-off between now and commit changes the policy
size; recompute it from the dry-run's own reads.

## Stage 1 — create the deployment (dry run, then commit)

Return-by = commit time + **6 d 20 h** (the practice that leaves recall
margin inside the 7-day cap): `RB=$(( $(date -u +%s) + 590400 ))`.

Cycle 1's recorded command used `--deployment-kind proof`; the memory says a
7-day window needs `standing`. **Run the dry run with `standing`; if it refuses
the window, run it with `proof` — the dry run is read-only either way, and the
one that passes is the one to commit.**

```bash
RB=$(( $(date -u +%s) + 590400 )); docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs deploy --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --assets 10243759 --return-by $RB --deployment-kind standing --observability-url "http://127.0.0.1:8787/monitor/deposit-pool?pool=0x9B35A102d656Fb86d798aF81959e09961DEc28E0" --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 --use-kms 2>&1 | grep -v "failed to detect network" | tail -40
```

Read: predicted deployment id **2**, assets 10.243759, the admission check
(`assertDeployAdmission`) passing, no refusal. Paste the tail. Then the same
line with `--commit` appended and the SAME `$RB` (recompute it in the same
shell line so it cannot drift).

Record from the commit output: `deploymentId`, `adapterRequestId` (the pool's
request id — **read it from the receipt, never predict it**), tx hash, block.

## Stage 2 — stage and dispatch the XCM legs (dry run, then commit)

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-dispatch.mjs stage-dispatch --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --request-id <adapterRequestId from stage 1> --deployment-id 2 --observability-url "http://127.0.0.1:8787/monitor/deposit-pool?pool=0x9B35A102d656Fb86d798aF81959e09961DEc28E0" --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 --use-kms 2>&1 | grep -v "failed to detect network" | tail -60
```

Read: lane strategy `AAC_IDLE_HYDRATION_V1` (never the legacy id), the
funding + sell legs, fee ≤ 40k / float 50k per leg, par-law check. Then
`--commit`. **Once staged, cancel is forbidden by the contract; resume is the
only exit** — do not interrupt between the legs. Cycle 1 took ~11 h from
stage to lane settlement; watch `status` with the same flags until
`deposit_sell` and the lane settlement show.

Then settle the pool side:

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs settle --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --deployment-id 2 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 --use-kms --commit 2>&1 | grep -v "failed to detect network" | tail -30
```

Record **entry friction** = assets out − aUSDC received at par (cycle 1:
0.021702) and the far-side aUSDC balance at t₀ with its timestamp.

## The measurement (day 3 and day 6, read-only)

The rate is the far-side balance growth, not the pool's NAV:

`rate = (aUSDC_now − aUSDC_t0) / aUSDC_t0 × 365 / days_elapsed`

Read the adapter's aUSDC balance on Hydration through the observability page
(`/monitor/deposit-pool?pool=…`) or the dispatch `status` command; write both
readings with timestamps into the cycle record. Two readings (day 3, day 6)
show whether the rate is steady or the 19 % was a spike.

## Stage 3 — recall on day 6 (before `returnBy`), settle, close

Three transactions, same as cycle 1 (recall → stage-recall → settle), each
dry-run first:

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs recall --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --deployment-id 2 --assets <far-side aUSDC balance, raw> --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 --use-kms 2>&1 | grep -v "failed to detect network" | tail -30
```

**Recall the whole far-side balance including accrued interest.** Cycle 1
recalled 9.930137 against 9.980137 out and left 0.01743 of yield plus 1.5326 of
float parked on Hydration — the measurement must bring the interest home so the
pool's own ledger shows it. If the script caps `--assets` at the deployment's
principal, say so in the record and recall the principal; the rate is still
read from the far side. Then `stage-recall` (`--recall-id 2`, request id from
the recall receipt) and `settle --recall-id 2`, each dry-run then commit.

Close the cycle: `writeOffVenueLoss(2, <principal − returned>)` is a multisig
call only if principal did not fully return (cycle 1 needed it for 51,765 raw);
with C of v2.2 this step disappears. Record exit friction, round-trip friction,
and the rate.

## What goes into the record (docs/evidence/pool-v21-cycle-2.md)

deployment id, both request ids, all tx hashes with blocks, assets out,
aUSDC received, entry friction, the day-3/day-6 readings, recall amount,
returned, exit friction, round-trip friction, annualised rate over the
measured span, and the subsidy amount to attest on `/pool` (the same
Substrate-attestation path as the 0.60 entry).

## Abort rules

- Any dry run that refuses → stop, paste, do not switch flags to make it pass
  (the `standing`/`proof` choice above is the one exception, both read-only).
- A staged deployment that stalls → `status`, then `resume` per
  `PACKET_DISPATCH_RESUME.md`; never a second stage.
- If `totalAssets` falls below 20.0 before commit (a redemption), recompute the
  policy size; if the policy size falls below 9.0, do not run — the cycle's
  cost rises and the pool is telling us something first.
