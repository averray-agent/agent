# Ceremony runsheet — Pool v2 yield epoch 1 (deposits start earning)

Status: PREPARED 2026-08-13 late evening. Execute on a FRESH session — packet 6
rule 4 (never same-day alongside incident work) applies to today twice over.
Operator: Pascal (KMS creds). Claude gates the script, then gates every leg.
Ratified basis: PACKET_YIELD_CEREMONY (packet 6) — this runsheet instantiates it
for pool v2 after the 2026-08-13 L1 cutover.

What it does: pool-v2 buffer capital deploys to Hydration/Aave through the new
lane (`HYDRATION_USDC_POOL_V1` → `0x88eE7027…371f` → wrapper → XCM), the
epoch-1 mechanics (proven 2026-08-06, friction 0.202%, every raw unit
reconciled) now running where depositors' money lives. Product effect:
`yieldStatus` flips `not_yet_earning` → `earning` on the pool door at leg A.

Invariants:
- **The exit floor is contract law**: `bufferFloor() = assets of the largest
  agent position ever issued` — any single depositor can always exit instantly
  from buffer. Measured live: floor 10.0 = dogfood's whole position →
  `maxDeployableAssets() = 0` today. **A single-depositor pool cannot deploy
  its only depositor's money — by design.** Hence precondition 2.
- Operator principal (`contributeOperatorPrincipal`) mints shares to the POOL
  itself (`operatorPrincipalShares`), NOT an agent position — it raises
  deployable capital without raising the floor, and rounds down so it can
  never dilute depositors.
- Cost-basis rule (#1075): share price steps only at recall recognition,
  never by settler fiat.
- The un-revertable window (XCM in flight) is bounded to the 2-USDC proof
  tranche until legs A–C reconcile exactly.

## §0 Preconditions (gate each; 1–3 are build/ops work BEFORE ceremony day)

1. **Lane/VA manifest aliasing PR** — the ceremony script fail-closes today
   (verified): it binds `contracts.hydrationDepositPoolAdapter` and asserts it
   equals `pool.venueAdapter()`; those keys still hold the v1 instances.
   Repoint `contracts.depositPoolLane` → `0x88eE7027…371f` and
   `contracts.hydrationDepositPoolAdapter` → `0xE2801E6C…9a35` (escrow-style
   aliasing with the V2-suffixed keys, same as #1115's depositPool repoint),
   with the fixture moves. Merged + deployed before ceremony day.
2. **Seed operator principal — DECISION 1 (Pascal)**: amount + source.
   Recommendation: **+10 USDC** → totalAssets 20, floor stays 10,
   `maxDeployableAssets` 10, policy cap (≤50%) also 10 — clean numbers.
   Mechanics: the USDC must sit as ERC-20 on the operator EOA (KMS signer
   `0x5a6836…5813`) and the contribute call is `onlyOperator` — so: Coinbase →
   Hub (proven $0 route) to the signer's SS58, then a KMS-signed
   `approve + contributeOperatorPrincipal(10_000_000)`. The ceremony script has
   no `contribute` subcommand — small KMS helper needed (prep item, mirrors
   the fund-signer script shape). Source note: NOT the reward bank — bank
   funds are reward earmarks; operator principal is a distinct book
   (`operatorContributedPrincipal`, its own event).
3. **Observability green** — RESOLVED 2026-08-13 evening: there is NOTHING to
   repoint. The monitor repo has zero pool bindings; the Bank feed and the
   pool observability snapshot are served by the PLATFORM BACKEND
   (manifest-driven, already v2). The snapshot endpoint is INTERNAL-ONLY:
   `GET backend:8787/monitor/deposit-pool` — Caddy deliberately 404s
   `/monitor/*` publicly ("Hermes reaches backend:8787 directly").
   Day-of: the VPS publishes the backend on host loopback **18787**
   (`127.0.0.1:18787->8787/tcp`, read from docker ps 2026-08-13). Tunnel:
   `ssh -L 18787:127.0.0.1:18787 ubuntu@141.94.121.188` →
   `--observability-url http://127.0.0.1:18787/monitor/deposit-pool`.
   Verified live 2026-08-13 18:20Z: snapshot serves pool v2, totalAssets
   20.0 = shares, block seconds-fresh, principal-cost-basis.
   Verify pre-leg-A: snapshot shows pool 0x6061f0aC…, `reconciled: true`,
   `flows.status: "ok"`, fresh ≤10 min (the script re-enforces all of it).
   - Dispatcher/observer: keyed on the WRAPPER (unchanged address), so no
     repoint expected — leg A's dry-run evidence block is the verification.
   - Treasury-page tiles (credit line / lanes / XCM observer) light up only
     after PACKET_TREASURY_LIGHTUP lands (separate Codex build; the page's
     "not emitted by API yet" placeholders are honest until then).
4. **No pending redemptions** — read, not assumed. Verified 2026-08-13:
   `nextRedeemRequestId` = 1, none open. Re-read on the day.
5. **Gas**: operator KMS signer holds 8.91 DOT (ample; venue legs are calls,
   not CREATEs). Re-read on the day.
6. **Script gate (Claude, before commit day)**: dry-run
   `pool-venue-ceremony.mjs` against mainnet post-aliasing; verify the
   evidence block's live reads; **check the returnBy discipline** — the script
   constant `STANDING_RETURN_WINDOW_SECONDS` is 14 days but the contract caps
   deadlines at `NOTICE_7_DAYS` (604800s, read live; packet 6 already errata'd
   14d→7d) — confirm the script clamps or refuses, else fix before use.
   Guards to exercise: wrong signer, over-policy, pending redemptions.

## §1 Policy (ratified packet 6, v2 numbers at totalAssets = 20)

| Parameter | Value | Source |
|---|---|---|
| Deployed fraction cap | ≤ 50% of totalAssets → ≤ 10 USDC | packet 6 §1 |
| Contract deployable | `maxDeployableAssets()` = buffer − floor = 10 | contract law |
| Proof tranche (leg A) | 2 USDC, `returnBy` = now + 48h | packet 6 §2 |
| Partial recall (leg C) | 0.5 USDC | packet 6 §2 |
| First standing (leg D) | 5 USDC total deployed, `returnBy` ≤ 7d | conservative start under the 10 allowed |
| Deployment cadence | `DEPLOYMENT_EPOCH` = 1 day-epoch → legs A and D on different days | contract law |

## §2 The legs (each: dry-run → Claude gates → --commit; KMS signer only)

All commands run from the repo root; write mode is exactly
`--commit --use-kms --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813`.
The script never accepts a raw key.

**Leg A — proof tranche out** (day 1):
```
node scripts/ops/pool-venue-ceremony.mjs deploy --profile mainnet \
  --assets 2000000 --return-by <unix, use now+47h — the +48h boundary trips the strict check> \
  --deployment-kind proof --observability-url http://127.0.0.1:18787/monitor/deposit-pool \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```
(Gate-run evidence 2026-08-13: the script walked five sequential fail-closed
refusals — missing signer, missing returnBy, +48h boundary, policy, missing
observability — and the identity asserts passed post-aliasing. The
observability guard requires the feed to be `reconciled: true`, `flows.status
ok`, fresh ≤10 min, matching pool + chain timestamp — precondition 3's
repoint work is self-enforcing here.)
Gates: `VenueDeploymentCreated(deploymentId, adapterRequestId, 2e6, returnBy)`;
`venuePrincipalCostBasis` +2e6 exactly; `buffer + deployed == totalAssets`;
far-side aUSDC position on Hydration carrying the adapterRequestId (epoch-1
evidence pattern) captured before proceeding; pool door `yieldStatus` →
`earning`; share price UNCHANGED.

**Leg B — async settle** (same day, after the adapter reports terminal):
```
node scripts/ops/pool-venue-ceremony.mjs settle --profile mainnet \
  --deployment-id <ID> --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```
Gates: `VenueDeploymentSettled(…, status, settledAssets)`; books == chain;
share price still unchanged.

**Leg C — partial recall + yield recognition**:
```
node scripts/ops/pool-venue-ceremony.mjs recall --profile mainnet \
  --deployment-id <ID> --assets 500000 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```
Gates: buffer rises by the returned amount; **yield-recognition math verified
by hand** — anything above remaining cost basis for the tranche is realised
yield and the share price steps exactly then (first live observation of the
cost-basis rule). Tombstone probe silent throughout A–C (its silence is an
acceptance item).

**Leg D — standing deployment** (next day-epoch, only after A–C reconcile
exactly): deploy to 5 USDC total, `returnBy` +7d, re-deploy on settle, weekly
cadence. An expired `returnBy` is an incident, not a shrug.

## §3 Reconciliation (the epoch-1 standard)

Every leg's evidence block must match Claude's independent chain reads, and
the ledger closes to zero unexplained raw units: committed = deployed + float
+ transfer fee + remote exec fee, refund tail accounted (v1 epoch: 10,050,000
= 10,000,000 + 29,776 + 582 + 19,642, surplus 19,408 refunded — that exactness
is the bar). The aToken-rebase seam (observer-capped `min(observed,
requested)`) is KNOWN: pre-settlement yield lands principal-shaped at raw-unit
scale — record it, don't chase it.

## §4 Abort table

| Failure | State | Action |
|---|---|---|
| Leg A dispatch refused (preview/bind law) | Nothing moved | The #964/#967 class; stop, read the wrapper preview evidence, fix, retry. |
| Leg A in flight, no far-side evidence | 2 USDC crossing | Wait out the XCM timeout; the request either lands or the fee-guard refunds; observer settles terminal status either way. Bounded loss ≤ proof tranche. |
| Leg B settle shows loss/partial | Books diverge from plan | STOP. No leg C/D. Reconcile the exact units first; a loss write-down is a decision, not a default. |
| Leg C return ≠ requested | Partial liquidity at venue | Investigate venue-side; buffer floor still covers every agent exit (invariant). |
| Any books-vs-chain mismatch | — | Ceremony stops; capital recallable via leg C's proven path. |

## §5 Product surface (what lights up, honestly)

- Pool door `yieldStatus` → `earning` at leg A — automatic, one source, verify
  on endpoint + tile + packet-4 field (all three).
- Operator-app Treasury tiles (credit line cap, allocation lanes, XCM
  observer, policy gate) stay on their honest placeholders until
  PACKET_TREASURY_LIGHTUP ships the API emitters — the epoch then gives the
  lanes/observer tiles their first real rows. Never light a tile from
  invented data to make the page look alive.

## §6 Not in scope

Raising pool caps · promoting deposits publicly · lock-up economics · the
operating lane's position (its unbooked epoch-1 yield stays parked) · first
credit draw (own supervised run, after a live v3 job flow exists to repay
from) · EscrowCore v3 §7 proofs.
