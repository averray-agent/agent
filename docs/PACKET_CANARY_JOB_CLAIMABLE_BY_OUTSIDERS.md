# PACKET — the canary's job was claimable by an outsider, and the canary gives up before its own claim finishes

Status: **ready for Codex, 2026-09-22.** Two PRs. Everything below is read
from chain, the public arrivals snapshot and the canary artifacts; no
production logs needed. The harmed worker's remedy (overturn + arbitration)
is operational and is NOT in this packet — see
`RUNSHEET_MAKE_THE_CANARY_CLAIMANT_WHOLE.md`.

## 1. What happened

**An outside worker paid for our canary's failure.** Canary run 35663784405
(2026-09-21 22:39Z, the deploy-triggered run right after #1398) got a **502 on
`POST /jobs/claim`** and a **502 on `POST /admin/jobs/lifecycle`** (the
archive in cleanup): `WARNING: failed to archive canary job
worker-canary-1790030423761`. The job (chain `0x1ca6302b24d579af…fd83`,
0.1 USDC, lane `liveness`, verifier `benchmark`) stayed listed. On 2026-09-22
13:04Z outside worker `0x29A23c57B07B09806A3447cc76C6C70BBE13BBBA` claimed it
**through our API** (the `JobClaimed` tx sender is our KMS signer, brokered),
locked stake 0.01 + claim fee 0.05, submitted, and the benchmark verifier
rejected at 13:05:36Z. Left alone, `finalizeRejectedJob` after 2026-09-29
13:05Z slashes them — a slash on their record also hard-zeroes L2 credit
underwriting.

**The same trap exists twice more, right now.** `worker-canary-1790023075526`
(`0x8e24acd9…5b99`, run 35652160176) and `worker-canary-1790078516452`
(`0x26658513…ef65`, run 35724664046): the canary gave up at its client
timeout, the claim landed ~1 min later under the abandoned canary wallet, the
1 h `claimTtlSeconds` expired, `handleClaimTimeout` reopened them, and both
are **Open on chain** today. They are archived — but the claim gate checks
delisting only for external jobs (`job-execution-service.js`, the
`External job … was delisted` branch), so anyone holding the id can claim
them through `POST /jobs/claim`. Canary job ids are visible on `/jobs` for
the minute between create and archive; agents that poll (0x29a23c57 has
1,123 `GET /jobs/preflight` calls) see them.

**The canary aborts claims that are still healthy — my spec error.**
Runs 35652160176 and 35724664046 failed with `The operation was aborted due to
timeout` at claim. `PACKET_CANARY_HANGS_AT_THE_CHAIN_STAGES` asked for a client
abort "below the server deadline"; #1393 bounds **each receipt wait** at 60 s,
and a canary claim of a lazily materialised job runs up to **three sequential
transactions** (`ensureJob.create` → `ensureOnboardingWaiverEligibility` →
`claimJobFor`). `Math.floor(serverTimeoutMs * 5 / 6)` = 50 s is below one
transaction's budget, let alone three. Then cleanup archived a job whose
claim was still in flight.

Also: the canary header promises "canary jobs never accumulate or pollute the
public board"; `/jobs` lists three canary jobs today.

## 2. PR A — a canary job is claimable only by its own canary, and never stays open

**D1 — reserved claimant.** The canary creates its wallet before the job.
`buildCanaryJob` gains `reservedClaimant: <canary wallet>`. Admin job create
accepts the field only with operator auth. The claim gate **and preflight
(same rule — preflight must mirror the claim gate)** refuse every other wallet
with a named `job_reserved` before any chain work. Reserved jobs are never
listed on public `/jobs`.

**D2 — delisted means unclaimable, for every job.** The claim gate and
preflight refuse archived/delisted curated jobs the same way they refuse
delisted external jobs (`job_delisted`). This closes the August "claim ignores
delisting" gap generally, not just for canaries.

**D3 — stranded-canary sweeper.** A keeper (env flag in
`deploy/backend.env.template`, re-render the mainnet template) that finds
canary-class jobs — lane `liveness` AND poster = operator signer AND id prefix
`worker-canary-` AND a `reservedClaimant` or the legacy prefix; refuse if any
signal disagrees — and:
- Open on chain and ≥ `MIN_OPEN_FOR_CANCEL` old (read `createdAt` + the
  contract constant) → `cancelOpenJob` via the #1393 wait helper, then archive;
- Claimed and past `claimExpiry` → `handleClaimTimeout`, then cancel as above;
- anything else → leave it and log why.
Idempotent, logs `canary_job_cancelled {jobId, chainJobId, refundRaw, txHash}`.
Refunds land in the reward bank. Its first run must cancel `0x8e24acd9…` and
`0x26658513…` — put those two in the handback.

**D4 — cleanup retries.** `archiveCanaryJob` retries with backoff (≈5 attempts
over ≈2 min) and records the final outcome in the artifact. After D1 a failed
archive is cosmetic, but the board should stay clean.

Tests (each mutated red → green in the handback): another wallet claiming a
reserved job → `job_reserved` on claim **and** preflight; archived curated job
→ `job_delisted`; sweeper cancels an Open canary job older than the floor,
refuses a non-canary job of the same age, leaves a younger canary job alone;
claimed-and-expired → timeout then cancel; loosening the sweeper's canary
filter must fail a test.

## 3. PR B — the canary's claim budget covers the whole claim

**D5 — budget from the server's shape.** Claim-stage client timeout =
3 × (`BROKERED_TX_TIMEOUT_MS` + 2 s recovery) + 30 s headroom (222 s at the
default), derived from the same env value the server reads, never hardcoded.
Node's fetch has its own header timeout (undici, 300 s default), and the
configured maximum (120 s per receipt) would exceed it — pass a dispatcher
whose `headersTimeout`/`bodyTimeout` are the budget + 10 s so the canary's own
abort always fires first. Submit gets its own budget from its own transaction
count.

**D6 — an abort is not a failure.** After any claim-stage abort, 5xx or network
error, poll the deterministic session (`${jobId}:${wallet}`) every 5 s for up
to 3 min — #1393 made session reads converge a landed claim.
- converged → continue the lifecycle (submit, verify, settle, recover) and mark
  the run `passed_after_client_timeout` with elapsed times; this is exactly the
  external-worker path worth proving;
- not landed and no pending claim → fail `claim_not_landed`;
- otherwise → `unknown`.
Cleanup runs **after** this decision; never archive a job whose claim may still land.

**D7 — make the latency visible.** The artifact records the chain block
timestamps of the job's `JobCreated`, the waiver transaction and `JobClaimed`
(public chain reads), next to client elapsed per stage. That tells us which of
the three transactions is slow without a VPS log pull.

Tests: budget derived from env (default → 222 s; dispatcher timeout above it);
claim abort + session converges → run continues and passes; claim abort + no
landing → `claim_not_landed`; cleanup never precedes the D6 decision.

## 4. Out of scope — noted

- Claim latency for lazily materialised curated jobs hits real workers too
  (three sequential transactions). D7 measures it; optimisation is a follow-up.
- Arrivals over-counts outsiders: the operator viewer wallet `0x062de35f…`
  is counted as an outsider; canary wallets become outsiders once the 15-min
  marker expires; `0xb9dc005f…` (run 35663784405's canary wallet) shows 163
  `GET /jobs` over 13 h after its run with no token in logs or artifacts —
  unexplained attribution. File as an issue.

## 5. Handback

Two PR numbers, CI, test names with drill evidence, and after deploy: the
sweeper's first-run lines for the two cancellations (tx hashes, refunds) and
the next **scheduled** canary artifact.
