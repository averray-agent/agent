# Packet D0 — Capacity, not entitlement: tier-3 redesign + deposit vesting

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Implementer:** Codex · **Operator:** Pascal
**Supersedes:** the allowance formula shipped in #1095 (`PACKET_TIER3_POOL_ALLOWANCE.md` §allowance). The pool
contracts, the door (#1099/#1101), observability (#1098), and the S/E/D valve *machinery* all stand — this packet
changes what deposits **mean**, not how the pool or the valves work.
**Sequencing (hard):** must land before any raise of the pool caps (1,000/100), before any raise of the catalogue
budget, and before any deposit solicitation. No deploy window may exist in which the door advertises the old
semantics while the new resolver is live, or vice versa — resolver, door copy, explain/preflight, and smoke flip in
the same deploy.

## 1. Context — what the external review ruled, and what the code actually does

The consolidated economic review (2026-08-12) confirmed one design blocker, D0: under #1095, one deposited USDC
buys ~one USDC of **daily, renewing** claim capacity against rewards **we** fund. 100 USDC deposited → up to
~3,000 USDC/month of gross catalogue entitlement. A lock-up changes the timing of the exit, not the ratio. The
ruling, verbatim in effect:

> Deposits raise **concurrency, job-risk limits, and access to externally funded work**. They do **not** create
> proportional entitlement to operator-funded catalogue rewards, which sit under a separate global budget that
> deposits cannot raise. Onboarding becomes a small **finite lifetime credit**, not a renewing faucet. Raised
> allowances **vest in over ~24–72h**, **drop instantly on withdrawal**, and scale **concavely**.

Calibration (also the review's): this is a design blocker for **scale**, not a live emergency — today's only
depositor is our own dogfood wallet and the valves bound today's exposure. That is exactly why it lands now,
while changing semantics strands nobody.

What `origin/main` does today (both files import `isExternalJob`):

| Lane | D — daily exposure (`worker-daily-exposure.js`) | E — open exposure (`worker-exposure.js`) | What deposits buy |
|---|---|---|---|
| Catalogue (operator-funded) | `1.50 + deposited × 1.0` per rolling 24h | 2.5 USDC cap | **Renewing daily catalogue entitlement — the defect** |
| External (poster-funded) | skipped (`external_job_has_no_operator_exposure`) | skipped (`external_job_is_poster_funded_and_worker_pays_claim_gas`) | Nothing — no capital gate exists |

The deposit multiplier applies **only** to the lane the review says deposits must never raise, and the lane
deposits **should** govern has no per-wallet capital signal at all. D0 is therefore an inversion, and it is
self-consistent once inverted: **the subsidy lane becomes deposit-blind, and the deposit lane is subsidy-free.**
That decomposition is also the Sybil answer — splitting capital across wallets can no longer touch operator
money (the catalogue budget is global and deposit-blind), and on the external lane more wallets doing more
poster-funded work is revenue, not leakage.

Reframe to carry into every surface's language: a deposit stops being "identity." A **time-weighted deposit is
one capital-backed trust-and-capacity signal, used alongside verified work history and reputation.** (This same
vested signal later feeds receipt-graph underwriting in the planned credit layer — forward pointer only, out of
scope here.)

## 2. The model after D0

Two lanes, four rules:

**Catalogue lane (operator-funded rewards) — deposit-blind, twice-bounded.**
1. **Per-wallet:** an *un-established* wallet draws catalogue exposure from a **finite lifetime credit** `L`
   (default 10 USDC). A wallet becomes **established** by verified work — `N` settled-and-approved catalogue
   jobs (default 10) — and only then unlocks the renewing daily base `D_base` (unchanged 1.50/24h rolling).
   Deposits change none of these numbers, ever.
2. **Global:** all catalogue claims additionally draw from a **global rolling-24h catalogue budget** `G_cat`
   (default 25 USDC exposure/day) — the operator's aggregate marketing-spend valve, same shape as the tier-0
   subsidy budget (`SUBSIDY_DAILY_BUDGET_USDC` pattern). This is the true Sybil bound: no wallet count moves it.

**Deposit lane (what vested capital actually buys) — subsidy-free.**
3. **Concurrency + job-risk:** the open-exposure cap E rises concavely with vested deposits:
   `E_cap = 2.5 + 0.5 × floor(sqrt(vestedWholeUSDC))` USDC. At the 100 per-agent pool cap: +5.0 → 7.5 open.
4. **Access to externally funded work:** external claims get their first capital gate — a per-job reward
   ceiling `maxExternalReward = 1.0 + 1.0 × vestedUSDC`. Base wallets may claim external jobs up to 1.0 USDC;
   a wallet with 10 vested may take an 11-USDC external job. This is collateral-like and deliberately linear
   (Review-delta RD-1 below). External jobs remain worker-paid-gas and remain outside D/E daily accounting.

**Vesting (applies wherever `vested` is read).** Deposit tranches are reconstructed from the pool's own
ERC-4626 `Deposit`/`Withdraw` events (pool `0xCCF5FDF3…F476`, deployed ~block 19,380,900 — trivially small log
range, cacheable). Each tranche vests **linearly from 0→100% over 48h** from its deposit block timestamp.
Withdrawals burn tranches **LIFO** (newest first): long-standing capital keeps its standing; a flash deposit is
the first thing burned. `vested(wallet, now) = Σ tranche.assets × min(1, ageHours/48)`, integer math in raw
units, rounding down. Properties, all required by the ruling: a fresh deposit buys ~nothing for hours (ramp);
any withdrawal reduces `vested` in the same block (instant decay — the burned tranche is gone from the sum);
yield attribution via `recordVenueReturn` raises `assetsOf` but emits no `Deposit`, so **yield never raises the
trust signal** — vesting counts deposited principal only (conservative, fail-closed, and honest).

**Worked example — the flash-deposit attack, post-D0:** deposit 100 USDC, claim immediately: catalogue daily
unchanged (deposit-blind), E raise after 1h ≈ `0.5×floor(sqrt(2))` = +0.5 USDC open, external ceiling ≈ 3 USDC
— against a lane with poster-funded rewards. Withdraw: LIFO burn, everything reverts. Extraction requires real
verified work under `G_cat`. The attack the review named yields ~nothing.

## 3. Workstreams

**D0-A — Make the daily budget deposit-blind.** In `mcp-server/src/core/worker-daily-exposure.js`:
`resolveDailyExposureBudget` returns the base only; delete the deposited-assets term and the
`readDepositedAssets` plumbing from `resolveBudget`; `dailyAllowance`'s public shape drops
`fromDeposits`/`depositedAssets` fields (surfaces in D0-F updated in the same PR). **Retire
`WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI` loudly:** if the env var is set at all, `loadWorkerDailyExposureConfig`
throws `ConfigError` naming this packet — stale config must never silently resurrect the old semantics. Deploy
templates (committed source of the rendered env, per the platform-stack env topology) drop the var in the same PR.

**D0-B — Global catalogue budget `G_cat`.** New module `catalogue-daily-budget.js` mirroring the tier-0 subsidy
budget's rolling-24h aggregate accounting, but denominated in **exposure** (reserved reward + brokered gas — the
same `workerExposurePolicy` components D already uses), aggregated across **all** wallets' catalogue claims.
Refusal reason `catalogue_daily_budget_exhausted`, with `retryAfter` derived the same way D does (oldest claim
in window + 24h). External jobs never touch it. Zero is the kill-switch, same convention as D.

**D0-C — Lifetime credit + graduation.** Per-wallet, catalogue lane only: cumulative lifetime catalogue
exposure is charged against `L` (`WORKER_LIFETIME_CATALOGUE_CREDIT_RAW`, default 10_000_000) until the wallet
is established: `settledApprovedCatalogueJobs ≥ N` (`WORKER_GRADUATION_SETTLED_JOBS`, default 10), computed
from the state store's wallet sessions (settled + approved outcome — auto-verify makes settled imply verified).
Established wallets switch to the renewing `D_base` rolling window (existing behavior). Refusal reason for an
exhausted un-established wallet: `lifetime_catalogue_credit_exhausted`, and the payload must say how graduation
works (jobs settled so far, `N`, and that external work is ungated by this). Tier-0's 3 lifetime brokered claims
are unchanged and remain the only brokered-gas onboarding. Runway check: L=10 at ~0.28 exposure/typical job ≈ 35
jobs; graduation needs 10 — generous, bounded.

**D0-D — Vesting calculator.** New module `deposit-vesting.js`: pure function from
(`Deposit`/`Withdraw` event list, `now`) → `{ vestedRaw, tranches }` per §2 (linear 48h ramp,
LIFO burn, raw-unit integer math, round down). Gateway side: read pool logs from the deployment block, cache by
block number; on any read failure return `vestedRaw = 0n` (fail-closed — a read failure may delay a raise,
never grant one — same belt-and-suspenders convention the #1095 resolver used). `WORKER_DEPOSIT_VESTING_HOURS`
default 48.

**D0-E — Wire vested into E and the external ceiling.** `worker-exposure.js`: cap becomes
`capUsdc + vestedOpenExposureRaise` where the raise = `floor(sqrt(vestedWholeUSDC)) × WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW`
(default 500_000). External claims: replace the unconditional skip with the ceiling check
`rewardRaw ≤ WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW + vestedRaw × (WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI/1000)`
(defaults 1_000_000 and 1000). New refusal reason `external_reward_exceeds_capital_ceiling`, payload naming the
ceiling, the wallet's vested amount, and that depositing (and letting it vest 48h) raises it. External jobs
still consume no D/E/G_cat budget.

**D0-F — Surfaces, one truth.** Preflight must mirror the claim gate exactly (parity is a standing defect
class — see `PREFLIGHT_WAIVER_PARITY_PACKET.md`): every new refusal reason appears identically in `claimJob`,
`preflightJob`, and `explainEligibility`. The door (`deposit-pool-door.js`, walkthrough, `/pool` payload):
remove every "deposits raise your daily allowance" claim; the authed view shows `vestedAssets`, the 48h
schedule, and what vested capital buys (`openExposureRaise`, `externalRewardCeiling`); the public payload
carries the plain-language reframe from §1 **and the standing disclosure line: "Technical pilot. Principal at
risk. No depositor protection."** (this folds the queued D8 disclosure dispatch into the same door change —
one edit, not two). Board: catalogue-budget tile (`G_cat` used/remaining/24h window) beside the #1098 pool
tiles. Smoke: `/pool` 200 + `available:true` + chain parity as today, plus asserts the disclosure line and the
**absence** of any daily-allowance-from-deposits field.

**D0-G — Tests.** The review's abuse cases, as red-first tests: flash deposit→claim→withdraw buys no catalogue
capacity and loses its raises on withdrawal (same-block decay); vesting ramp boundaries (0h/24h/48h/±1s); LIFO
burn on partial withdrawal preserves old-tranche vesting; yield-return events do not raise `vestedRaw`;
`G_cat` exhaustion refuses with `retryAfter` while external claims still pass; graduation boundary N-1 vs N;
retired-env `ConfigError`; external ceiling at base and at vested; preflight/claim/explain parity for every
new reason.

## 4. Config (all new/changed, with defaults)

| Env | Default | Meaning |
|---|---|---|
| `WORKER_DAILY_EXPOSURE_BUDGET_RAW` | 1_500_000 | unchanged — established wallets' renewing daily base |
| `WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI` | **retired** | presence → `ConfigError` |
| `WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW` | 25_000_000 | `G_cat` rolling-24h aggregate catalogue exposure; 0 = kill-switch |
| `WORKER_LIFETIME_CATALOGUE_CREDIT_RAW` | 10_000_000 | `L` for un-established wallets |
| `WORKER_GRADUATION_SETTLED_JOBS` | 10 | `N` settled+approved catalogue jobs → established |
| `WORKER_DEPOSIT_VESTING_HOURS` | 48 | per-tranche linear ramp (review band 24–72h) |
| `WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW` | 500_000 | E raise per `floor(sqrt(vestedWholeUSDC))` unit |
| `WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW` | 1_000_000 | external per-job ceiling, unvested wallet |
| `WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI` | 1000 | ceiling raise per vested USDC (1000 = 1:1) |

Budget-accounting note (gas study 2026-08-13): `G_cat` is claim-side **exposure** only. Posting-path costs
(~$0.028/listing measured) are their own operator line item and must not be double-counted into `G_cat`.

## 5. Migration — who feels what

Zero external-user impact, by construction and by timing. The two productive external workers (42 and 27
settlements) are established on day one (`N=10`) and never deposited — their behavior is bit-identical. The
only wallet that loses anything is our own dogfood depositor `0xdc1Ed1…EDeC` (10 deposited, 0 settled jobs):
its 11.50/day catalogue allowance becomes lifetime-credit `L` on the catalogue lane, while its vested 10 USDC
now buys `+0.5×floor(sqrt(10))=+1.5` open exposure and an 11-USDC external ceiling — which is the point, and
makes it the perfect post-deploy verification persona: its `explainEligibility` before/after IS the acceptance
demo. No state migration: lifetime-credit accounting may start from the deploy (historical catalogue exposure
of the dogfood wallet predates the concept; both externals graduate past it immediately).

## 6. Acceptance

1. All D0-G tests green; full suite green; no surface anywhere still computes or displays a
   deposits-raise-daily-allowance value (grep-clean for the retired concept, not just the env name).
2. Post-deploy, dogfood wallet: `explainEligibility` shows catalogue lifetime credit + vested 10 →
   `E_cap 4.0` (2.5+1.5) and external ceiling 11.0; `/pool` shows the disclosure line; smoke green.
3. `G_cat` visible on the board; setting it to 0 in a test env refuses catalogue claims with
   `catalogue_daily_budget_exhausted` while an external claim under the ceiling still passes.
4. Deploy templates carry the new envs and not the retired one; a config with the retired var fails startup loudly.

## 7. Review deltas (deliberate departures, for the second pair of eyes)

- **RD-1 — external ceiling scales linearly, not concavely.** The review asked for concave scaling of
  "benefits" blanket-wide. Concavity is the right shape where benefits draw on operator subsidy — but after the
  inversion, no deposit-derived benefit touches operator money. The external ceiling is collateral-like poster
  protection; linear collateral is the honest shape, and the E raise (which does gate shared infra concurrency)
  stays concave. If the reviewers disagree, `WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI` makes the slope a config
  knob, not a redesign.
- **RD-2 — the renewing daily base survives, behind graduation and `G_cat`.** A strict reading of "finite
  lifetime credit rather than a renewing faucet" could kill the renewing base entirely. With external demand
  still at zero, that would eventually dark every worker including our two productive ones — sequencing
  suicide. Instead the renewing faucet is now (a) earned by 10 verified jobs, not granted, (b) bounded
  per-wallet at 1.50/day, (c) bounded in aggregate by `G_cat`, and (d) explicitly operator marketing spend, not
  an entitlement. The finite-lifetime rule fully governs onboarding: 3 brokered claims + `L` until graduation.

## 8. Out of scope

Credit layer (workshops after this lands — D8 addendum); D4 fee schedule (unblocked by the gas study, separate
packet); lane-level catalogue hypothesis caps (D3); any EscrowCore v3 work; pool cap or `G_cat` raises (both
explicitly gated on this packet landing); any deposit solicitation (D8 quiet rule stands).
