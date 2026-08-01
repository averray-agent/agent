# Poster cancel/reclaim for external jobs — design packet

**Status:** design for decision · **Owner:** Pascal (decision) · Codex (chain/settlement
implementation) · Claude (this analysis, disclosure docs) · **Created:** 2026-08-01, day one of
allowlist-mode external posting (#873/#874). Design only — this PR changes no code.
Coordinates with `docs/POSTER_DOOR_CLARITY_PACKET.md` (PR #875): the disclosure requirements in
§6 are inputs to that packet's Deliverables A and B.

---

## 1. The gap

EscrowCore v2 (mainnet `0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC`,
`deployments/mainnet.json#contracts.escrowCore`) has **no externally callable cancel or
reclaim**. Verified 2026-08-01 by enumerating every external/public state-mutating function in
`contracts/EscrowCore.sol`: the only lifecycle escapes are

| Escape | From state | Precondition | Funds effect |
|---|---|---|---|
| `handleClaimTimeout` (permissionless, L646) | Claimed | past `claimExpiry` | worker stake slashed (½ poster, ½ treasury), job **reopens to Open** — no poster refund |
| `finalizeRejectedJob` (permissionless, L787) | Rejected | 7d `DISPUTE_WINDOW` lapsed | full poster refund via `_refundPosterBalances` (L974): unreleased reward + unreleased fee + reserves |
| `autoResolveOnTimeout` (permissionless, L814) | Disputed | 14d `ARBITRATOR_SLA` lapsed | 50/50 split, residual refunded |
| `resolveDispute` (arbitrator, L800) | Disputed | — | per-verdict split, residual refunded |

**Open is the one non-terminal state with no exit except a claim.** A funded job nobody claims
escrows the poster's `reward × (1 + feeBps/10⁴)` plus reserves indefinitely. The policy owner
(2-of-3 multisig) has no rescue hook either — its whole surface is `setProtocolFeeBps` and
`setTreasuryAccount`; pausing makes funds *more* stuck, not less.

Three concrete stuck shapes, all `state == Open, worker == 0`:

1. **Listed but unclaimed** — an unattractive external bounty sits in the catalog forever.
2. **Mismatch-orphaned** — funding lands on-chain but never matches a draft (wrong `specHash`,
   expired draft). The catalog entry never goes live, so *no worker can ever claim it*:
   guaranteed-permanent escrow. Packet T7's "unmatched funding is refundable via the mismatch
   path" currently **overstates** the chain: the mismatch path prevents listing; it refunds
   nothing (§6.3).
3. **Reopened-after-timeout** — a claim expires, `handleClaimTimeout` reopens the job, no second
   worker arrives. Same terminal-less Open.

This never mattered for operator-posted jobs (the operator's own funds; ingestion controls
supply). It is a real counterparty exposure now that external wallets fund escrow (#874
dogfood; `docs/EXTERNAL_JOB_POSTING_DESIGN.md` §7 promised recovery "through the existing
timeout/refund machinery" — true only for jobs that get claimed).

A structural corollary: the v2→v3 migration pattern
(`docs/ESCROWCORE_V2_PROTOCOL_FEE_MIGRATION.md` step 8) gates the legacy revoke ceremony on
"live-job count reaches zero". **A single unclaimed Open job holds a drain window open
forever.** `contracts.legacyEscrowCore` (v1) is still in the mainnet manifest; any stuck v1/v2
Open job blocks its wind-down. So an operator drain procedure for Open jobs is required
infrastructure regardless of what we ship posters.

## 2. Load-bearing finding: the deployed v2 already contains an operator rescue path

No contract change is needed to un-stick an Open job. The existing lifecycle composes into a
**unilateral operator drain** ("tombstone rescue"), every step already role-authorized:

1. *(optional, makes it free)* `setOnboardingWaiverEligible(jobId, true)` — operator
   (`onlyOperator`, L293).
2. `claimJobFor(jobId, janitor)` — operator (L570), with a designated janitor wallet. With the
   waiver flag and a janitor whose `workerClaimCount < policy.onboardingWaiverClaimCount`
   (manifest-recorded 3 — live-read before relying), claim economics are fully waived: zero
   bond.
3. `submitWorkFor(jobId, janitor, TOMBSTONE_HASH)` — operator (L616). Requires `claimTtl > 0`
   (submit must beat `claimExpiry`; a `claimTtl == 0` job cannot pass this step — see §4
   note).
4. `resolveSinglePayout(jobId, approved=false, REASON_OPERATOR_RESCUE)` — verifier (L672).
   Job → Rejected.
5. Janitor opens no dispute. After the 7-day `DISPUTE_WINDOW`, **anyone** calls
   `finalizeRejectedJob(jobId)` → `_refundPosterBalances` returns the full unreleased
   reward + protocol fee + reserves to the poster's AAC liquid balance (reserved→liquid book
   move, `AgentAccountCore.refundReserved` L328; poster withdraws via the normal AAC path).

Properties:

- **No new trust.** Funds can only move to the job's recorded poster. This composition also
  means the operator can *already* force-refund any Open job — worth stating plainly in the
  threat model; it grants no theft power.
- **Economics.** Waived: zero. Non-waived janitor: stake (10% of reward) slashes ½ to the
  poster (over-refund) and ½ to treasury; claim fee routes verifier-share/treasury
  (`AgentAccountCore.slashClaimFee` L652). Nothing leaves platform+poster hands. Waived is
  preferred: no fake slash entries in economics telemetry.
- **Latency:** ~7 days + four transactions. A faster variant exists (poster disputes the
  rejection, arbitrator resolves `workerPayout=0` immediately) but drags the human arbitrator
  ceremony in for a routine refund — keep it as the expedite option only.
- **Side effects (truth-boundary).** The rescue emits real `JobRejected`/`JobClosed` events, a
  janitor reputation slash (saturating-subtract on a zero-reputation burner — harmless, no
  revert), and receipts. These must be **labeled, not disguised**: a canonical
  `TOMBSTONE_HASH` (hash of a published `OPERATOR_RESCUE_TOMBSTONE` document) + a documented
  janitor wallet identity + a fixed reason code, so the indexer/receipts render "operator
  rescue: unclaimed-job refund" and never a fake failed delivery.
- **Coverage.** Works on all three stuck shapes of §1 — including mismatch orphans (the chain
  doesn't care that the catalog never listed the job) — and on legacy-v1 stock (same ABI),
  which makes it the drain tool for migration step 8.

## 3. Options

| | (a) v3 `cancelOpenJob` | (b) operator rescue runbook | (c) do-nothing + disclosure |
|---|---|---|---|
| Contract change | **new EscrowCore deployment + migration** | none | none |
| Poster latency | ~instant after floor | ~7d, operator-mediated | never |
| Trust model | trustless, poster-signed | operator goodwill + liveness | poster eats the loss |
| Covers mismatch orphans / v1 stock | v3 jobs only | **yes / yes** | — |
| Cost to ship | multisig ceremony ×2, auditor delta, dual-address drain window, deploy-gate pairing (`deployments/<profile>.json`, #706/D-03) | runbook + optional script | docs only |
| Honest at allowlist scale (~1 USDC bounties, enrolled posters) | over-spend now | **yes** | insufficient alone: silence about a known lock is a truth-boundary violation |

**(a) v3 contract delta — the right end state, sketched for the next deployment window.**

```solidity
mapping(bytes32 => uint256) public openSince;         // set at create AND at reopen
uint256 public constant MIN_OPEN_FOR_CANCEL = 1 hours;
event JobCancelled(bytes32 indexed jobId, address indexed poster, uint256 refundedTotal);

function cancelOpenJob(bytes32 jobId) external whenNotPaused nonReentrant {
    JobEscrow storage job = _jobs[jobId];
    if (job.state != JobState.Open) revert InvalidState();
    if (msg.sender != job.poster) revert Unauthorized();
    require(block.timestamp >= openSince[jobId] + MIN_OPEN_FOR_CANCEL, "OPEN_FLOOR_ACTIVE");
    _refundPosterBalances(job);
    job.state = JobState.Closed;
    emit JobCancelled(jobId, job.poster, ...);
    emit JobClosed(jobId, address(0), job.released);
}
```

Design choices, deliberately deviating from the first sketch of this task in two places:

- **Any-Open, not never-claimed-only.** A reopened-after-timeout job is *more* stuck than a
  fresh one (it burned a worker already). v2 storage has no "ever claimed" marker, so both
  variants cost one new storage slot; `openSince` (refreshed in `handleClaimTimeout`) is the
  more useful slot and re-arms the anti-bait floor at reopen. The poster was already
  compensated for the failed claim by the timeout stake slash.
- **Side mapping, not a struct field.** `jobs(bytes32)` returns the full struct; extending it
  changes the ABI tuple and breaks every backend/indexer decoder for no benefit.
- `cancelOpenJobFor(bytes32 jobId) onlyOperator`, refunding `job.poster` unconditionally —
  the established brokered-parity pattern (`claimJobFor`/`submitWorkFor`/`openDisputeFor`);
  replaces the tombstone dance for post-v3 janitor work; no theft power (recipient is fixed).
- Milestone jobs are covered for free: for a re-opened milestone job `_refundPosterBalances`
  already refunds only the unreleased remainder.
- **Rejected variants:** cancel-fee retention (spam pricing) — deferred; allowlist enrollment
  is the spam control today, and an owner-settable `cancelFeeBps` can ride a later delta if
  open-mode data demands it. Two-step `requestCancel` + notice window — complexity not
  warranted while claims land in minutes and mostly via the broker; the delist-first ordering
  of §5 achieves the same protection operationally.

**Griefing analysis for (a):**

- *G1 — cancel front-runs a claim.* Both `claimJob` and `cancelOpenJob` gate on
  `state == Open`; the loser reverts atomically. Worker downside is gas + pre-claim evaluation
  compute — the bond is never at risk (`lockJobStake` executes inside the claim tx or not at
  all). The floor does not remove post-floor races; the operational mitigation is ordering
  (§5): delist → broker refuses claims (requires the §5 chokepoint fix — today the claim path
  ignores delisting) → cancel. Residual exposure is direct `claimJob` racers; accepted.
- *G2 — bait-and-cancel / attention farming.* Post an attractive bounty, cancel before anyone
  can realistically respond, repeat. Mitigated by the 1h floor (a real claim beats the cancel
  well inside it), the enrollment allowlist, and the min-reward floor. Revisit the floor value
  and fee retention at open mode.
- *G3 — claim-blocking (worker side).* A worker who claims purely to block a cancel locks a
  real bond, is bounded by `claimTtl`, and on expiry forfeits half the stake **to the poster**
  before the job reopens (cancel available again after the re-armed floor). Self-limiting and
  poster-compensating.
- *G4 — zero-bond blocking.* Only possible on waiver-flagged jobs, which are operator-curated
  starter jobs, never external posts. Note and move on.
- *G5 — pause interaction.* `whenNotPaused` on cancel keeps kill-switch semantics uniform:
  pause freezes everything, including refunds. Consistent with every other path; documented,
  not changed.

**(b)** is §2, operationalized as a runbook (§4). **(c)** alone fails the truth-boundary bar,
but its disclosure content is mandatory groundwork for every option (§6).

## 4. Recommendation

**Ship (c)+(b) now; bank (a) into the next EscrowCore delta window. Do not spend a deployment
ceremony on cancel alone.**

1. **Now (docs/backend, this week):** disclosure per §6 into the poster-door packet's
   Deliverables A and B. Rescue runbook per §2 committed as ops doc; optional
   `scripts/ops/rescue-open-job.mjs` (Codex lane) wrapping steps 1–5 with the labeling
   sentinel. Allowlist-era support promise: *unclaimed-job refund on request, ~7 days,
   operator-mediated.* At current scale (1-USDC bounties, enrolled posters we talk to) this is
   honest and adequate.
2. **Next EscrowCore deployment window** (likely the open-mode audit delta, which packet §5
   already requires): include `cancelOpenJob` + `cancelOpenJobFor` + `openSince` per §3(a),
   following the `ESCROWCORE_V2_PROTOCOL_FEE_MIGRATION.md` pattern (redeploy preflight →
   deploy → multisig wiring → finalize → dual-address drain). The §2 runbook is the drain tool
   for whatever v2 Open stock remains at that point.
3. **Never:** an undisclosed locked state, or a catalog/receipt surface that dresses a rescue
   up as a delivery outcome.

Preconditions to note in the runbook: `claimTtl > 0` (a zero-TTL Open job defeats step 3 —
`_submitWork` requires `block.timestamp ≤ claimExpiry`; only a v3 cancel can free it — verify
the draft validator enforces a positive floor); janitor wallet designation + waiver headroom
live-read at run time.

**Decisions for Pascal:** ① confirm (c)+(b)-now/(a)-banked sequencing; ② designate + document
the janitor wallet; ③ approve waiver-flag use for rescues (vs. eating non-waived slash
noise); ④ 1h floor + any-Open scope for the v3 delta; ⑤ whether the ~7d rescue promise goes
in the public onboarding payload or stays in the human guide only.

**DECIDED 2026-08-01 (Pascal):** ① **confirmed** — (c)+(b) now, (a) banked to the next
EscrowCore deployment window. ② janitor = **a fresh dedicated EOA** (vault as
`averray-janitor`, used for nothing else; create it when the first rescue is needed).
③ **waiver-flag use approved** for labeled rescues. ④ v3 delta = **any-Open scope +
1-hour minimum-open floor**. ⑤ the ~7-day rescue promise is **public** — in the
`/poster/onboarding` payload AND the human guide (poster-door packet T9 + Deliverable A
`cancellation` object carry it).

## 5. Watcher/catalog coordination

The chain is truth; the catalog is a projection (`EXTERNAL_JOB_POSTING_DESIGN.md` §2). Cancel
and delist are different layers and must never be conflated — and the delist layer is weaker
today than its name implies:

- **Delist is discovery suppression only, and incomplete.**
  `POST /admin/jobs/external/:jobId/delist` (`external-job-routes.js:44`) writes one delisting
  record (`state-store.js:450`) and touches neither the chain nor the projected job row. The
  record is consulted at exactly two chokepoints: the `GET /jobs` filter
  (`job-routes.js:20-22`) and re-projection (`external-posting-service.js:415`). The claim
  path (`POST /jobs/claim` → `job-execution-service.js` → `gateway.js:1080` `claimJobFor`)
  **never reads it** — a worker holding the jobId can still claim a delisted job and the
  backend will broker it on-chain; `GET /jobs/definition`, `/jobs/recommendations`, and
  `/jobs/preflight` don't filter either, and delisting sits outside `acquireClaimLock`, so
  delist and a concurrent claim don't serialize at all.
- **Backend chokepoint fix (Codex, now — prerequisite for every option's ordering story):**
  consult `isExternalJobDelisted` inside the claim lock (refuse with an honest reason code)
  and filter the remaining discovery routes. Without this, "delist first" closes nothing.
- **Poster-visible status must not lie by omission.** Today a delisted job's draft record
  still reads `live` forever (`presentDraft` stops at `live`; delisting writes nothing back).
  The draft/job status enum needs `delisted` → `rescue_in_progress` → `refunded` (and later
  `cancelled`) so `GET /jobs/draft/:id` tells the poster the truth during a rescue.
- **Rescue-era ordering (b):** delist first (with the chokepoint fix, this actually closes
  the API claim window; a direct on-chain `claimJob` remains possible and is harmless — a
  genuine claim landing before rescue step 2 simply supersedes the rescue, because every
  rescue step *is* the normal lifecycle) → status *"delisted — operator rescue in progress
  (~7d)"* → tombstone steps → `finalizeRejectedJob` → status *"refunded"* only after the
  chain event.
- **v3-era ordering (a):** poster requests cancel (API) → delist + broker stops dispatch →
  poster signs `cancelOpenJob` (or brokered `cancelOpenJobFor`) → watcher consumes
  `JobCancelled` → catalog marks the terminal `cancelled` state. The catalog may not show
  `cancelled` before the chain event exists — the same discipline the draft→live watcher
  already enforces in the funding direction (T7).
- Indexer: `JobCancelled` joins the settlement-evidence event set; rescue tombstones render as
  operator-rescue, keyed by the sentinel hash + reason code.

## 6. Disclosure requirements (feed into POSTER_DOOR_CLARITY_PACKET Deliverables A/B)

Baseline: **no cancellation/refund language exists anywhere on the rail today.** The only
poster-facing prose is the draft funding note and the `valueSemantics` fee sentence
(`external-posting-service.js:22-23,137-139`); `GET /poster/onboarding` is itself not yet
implemented (design-table row only). So:

1. **`GET /poster/onboarding` (Deliverable A, Codex — to be built)** gains an `escrowExit`
   object, all live-read: `cancelSupported: false` (until v3); the escape table of §1 with
   live windows (`DISPUTE_WINDOW`, `ARBITRATOR_SLA`, per-job `claimTtl`); `operatorRescue` —
   one honest sentence ("unclaimed jobs: operator-mediated refund on request, ≈7 days") +
   contact, if Pascal approves ⑤; the sentence *"delisting hides a job; it does not refund
   it."* The clean-room bar applies: an agent must be able to conclude "funding is
   irrevocable until a terminal state" from the payload alone. `POST /jobs/draft` responses
   should carry the same object — consent at the money moment — and the `mismatch` status
   (already `permanent: true`) should point at the rescue path, since mismatch-orphaned
   funding is the guaranteed-stuck case.
2. **`docs/POSTER_GUIDE.md` (Deliverable B, Claude)** gains a pre-funding section — "escrow is
   one-way" — with the reward×1.05 worked example and a when-do-I-get-money-back table
   (claimed-then-abandoned → half the worker's stake + relist; rejected + 7d → full refund;
   disputed → per-verdict; never claimed → rescue on request, ~7d; *no self-serve cancel
   today*).
3. **Corrections to in-flight text (PR #875, via review comment — not edited here):** T7's
   "unmatched funding is refundable via the mismatch path" → "unmatched funding stays escrowed
   on-chain; recovery is the operator rescue path (~7d)". Same correction applies to
   `EXTERNAL_JOB_POSTING_DESIGN.md` §3 step 7's "recovers escrow through the existing
   timeout/refund machinery", which holds only for claimed jobs.

## 7. Lanes

| Piece | Lane | When |
|---|---|---|
| Delist chokepoint fix: claim path + discovery routes consult delisting, inside the claim lock (§5) | Codex | now |
| Poster-visible statuses `delisted`/`rescue_in_progress`/`refunded` on the draft record (§5) | Codex | with the rescue runbook |
| Disclosure into onboarding payload + draft response (§6.1) | Codex, inside packet Deliverable A | now |
| POSTER_GUIDE "escrow is one-way" section (§6.2) | Claude, inside packet Deliverable B | after A |
| Rescue runbook + sentinel doc (+ optional `rescue-open-job.mjs`) | Codex (chain/settlement owner), Claude gates | now |
| T7 / posting-design wording corrections (§6.3) | review comment on PR #875 | now |
| v3 `cancelOpenJob` delta + migration | Codex, per migration pattern; auditor delta | next deployment window |
| Decisions ①–⑤ | Pascal | before runbook first use |
