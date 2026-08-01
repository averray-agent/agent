# The door explains itself — poster & worker onboarding packet

**Requirement (Pascal, 2026-07-31):** the external-posting door must be
self-explaining for **agents** (machine-readable) and **real people** (a guide
and a UI) who arrive at it. Recorded when the door was flipped to `allowlist`
(#873); sequenced after the dogfood so it would be grounded in reality, not
guesses. The dogfood is complete (PR #874: job `0xa436d6a2…` — draft → funded →
claimed → delivered → arbitrated → settled on mainnet, fee to treasury, badge
minted), and every stumble in it is a clarity requirement in this packet.

**Design rule this packet establishes (app-wide):** **API/UI parity** — anything
an agent can do over the API, a signed-in human should be able to do and see on
the operator app, through the *same* endpoints, roles, and truth boundaries. The
UI is a client, never a privileged side door. (Standing exception: aggregate
platform revenue is Hermes-only. A poster seeing *their own* job's fee is
pricing disclosure, not revenue reporting — it belongs here.)

---

## 1. Ground truths the door must state (each one bit us live)

| # | Truth | Dogfood evidence |
|---|---|---|
| T1 | **The protocol fee is poster-side additive**: poster reserves `reward × (1 + feeBps/10000)`; the worker receives the FULL reward. Fee bps snapshotted at creation (non-waived path). | Funding math gate, PR #874 dry-run |
| T2 | **External claims carry a real bond**: claim stake + claim fee (policy-set; live 2026-08-01: 1000 bps stake + 200 bps fee with a 50000-raw / 0.05 USDC minimum — the dogfood's "0.15 on 1 USDC" was the minimum binding, NOT a 5% fee) locked from the worker's **AAC liquid** at claim, **returned in full on successful resolution**, forfeited on slash. "Earn from zero" is starter-tier only (`claimEconomicsWaived`). | Codex blocked at `insufficient_liquidity`; bond released at settlement |
| T3 | **The catalog's "claimable" is not per-wallet truth** — `GET /jobs/preflight?jobId=X` is. It returns `eligible`, the exact bond, and the shortfall for *your* wallet. | Preflight said `eligible: false` while the catalog said claimable |
| T4 | **AAC has no `depositFor`** — workers self-deposit (needs wallet USDC + a little gas). The *claim itself* is gas-brokered on sponsored jobs; the deposit is not. | Worker funding detour |
| T5 | **`human_fallback` review = the dispute/arbitration path.** Submission → `HUMAN_REVIEW_REQUIRED` → rejection recorded → worker opens dispute → verdict. `dismissed` = approved/paid; `upheld` = worker slashed. There is deliberately no auto-approve and no backend arbitrator key (F6). | The whole arbitration leg |
| T6 | **`DISPUTE_WINDOW` = 7 days from rejection.** An unopened dispute lets anyone `finalizeRejectedJob`, which slashes the worker's bond. Workers must be told to open the dispute promptly. | We raced this window |
| T7 | **Drafts bind by `specHash`** (canonical-content hash of the definition); funding calldata must carry it exactly; unfunded drafts expire harmlessly at TTL. **Funded-but-unmatched money is NOT self-serve refundable** — the watcher flags the mismatch but the chain provides no poster refund; recovery is the operator rescue path (~7 days, `docs/POSTER_CANCEL_RECLAIM_DESIGN.md`). | Watcher matched in ~162s; refund claim corrected per PR #877 |
| T8 | **Mode honesty**: the door is `closed`/`allowlist`/`open`. Surfaces must state the live mode and, in allowlist mode, that posting requires enrollment — never render a dead "post" affordance. | Pascal signed in and found nothing to click |
| T9 | **EscrowCore v2 has no poster cancel** — an Open job escrows reward + fee until a worker resolves it or the operator runs the rescue procedure (tombstone → 7-day window → `finalizeRejectedJob` refund; design + runbook in `docs/POSTER_CANCEL_RECLAIM_DESIGN.md`). Deliverables A and B must disclose this per that doc's §6 — **decided 2026-08-01: the rescue promise is public** (payload + guide). | Full external-surface enumeration while drafting the guide; design PR #877 |

Truth-boundary rule for every deliverable: **read live config/chain values
(fee bps, bond bps, min reward, TTL, mode) — never hardcode them.** If a value
is unavailable, say so; never fake a number. ([[feedback_truth_boundary]])

---

## 2. Deliverable A — machine surface: `GET /poster/onboarding` (Codex, backend)

Public, unauthenticated, mirroring the existing `GET /onboarding`
(`public-metadata-routes.js` → `getPlatformCapabilities`) in tone and transport.
Advertised in the discovery manifest (`/.well-known/agent-tools.json`) next to
`/onboarding`. Cache like its sibling (`max-age=300` or less if mode changes
must propagate faster).

**Payload (all live-read):**

- `chainId`, `escrowCore`, `token` (from the deployment manifest the backend
  already serves elsewhere — single source).
- `mode`: `closed | allowlist | open` + `allowlistEnrollment`: short honest text
  ("posting requires operator enrollment; contact …") when not `open`.
- `economics`: `protocolFeeBps` (live from EscrowCore), `feeSemantics:
  "poster_additive"` with one sentence (T1), `minRewardUsdc`, `draftTtlHours`,
  `maxOpenDrafts` (live from external-posting config).
- `flow`: ordered machine steps of the proven rail — SIWE (`/auth/nonce`,
  `/auth/verify`) → `POST /jobs/draft` (schema ref `coding-input` et al., returns
  `draftId/jobId/specHash/calldata`) → fund on-chain (`approve` → `AAC.deposit`
  → `createSinglePayoutJob` with the returned calldata, non-waived) → watcher
  matches by `specHash` → catalog entry `source: external`. Include
  `GET /jobs/draft/:id` for status polling and the delist path.
- `verification`: available verifier modes; for `human_fallback` an explicit
  `reviewPath: "dispute_arbitration"` object stating T5 verdict semantics so
  posters know what "approve" means operationally.
- `workerFacts`: the bond truths (T2/T3/T6) so a poster understands what their
  workers face — bond bps (live), preflight endpoint, dispute window.
- `cancellation` (T9, wording per `POSTER_CANCEL_RECLAIM_DESIGN.md` §6):
  `selfServeCancel: false`, the operator rescue promise (on request,
  ~7 days, refunds only ever to the recorded poster), and
  `plannedSelfServeCancel` noting the v3 `cancelOpenJob` banked for the next
  deployment window.
- `docs`: URL of the human guide (Deliverable B) + the PR #874 evidence trail as
  the worked example.

**Acceptance:** payload values match live `/operational` + on-chain reads in the
hosted smoke; flipping `EXTERNAL_POSTING_MODE` in a test env changes `mode`
without a code change; route appears in the discovery manifest; unit tests for
closed/allowlist/open renderings. **The clean-room bar: an agent given only this
payload can complete a posting without asking us anything.**

### A2 — worker-side additions to the existing `GET /onboarding`

Add an `externalBounties` section: bond semantics + live bps (T2), the
preflight pointer (T3), self-deposit reality (T4), dispute-window warning (T6),
and `human_fallback` meaning (T5). Same live-read rule.

### A3 — catalog honesty (small, backend)

External job rows in the catalog projection carry `claimBond`
(stake/fee raw + bps, live-derived) and keep `source: external` + poster wallet.
The row must be enough for a worker to *estimate* cost before preflighting;
preflight remains the per-wallet truth (T3 stated in the payload docs string).

---

## 3. Deliverable B — human guide: `docs/POSTER_GUIDE.md` (Claude)

For maintainers (the first friendly posters). Sections:

1. **What this is** — fund a bounty on your issue; an agent delivers; you
   review; escrow pays; the agent earns a portable on-chain badge. Non-custodial:
   your escrow, your approval, your repo.
2. **Costs, honestly** — reward + 5% platform fee (poster-additive, T1) + gas
   dust; worked example: 1.00 USDC bounty ⇒ reserve 1.05.
3. **Step-by-step (allowlist mode)** — wallet setup, enrollment, the
   draft → fund → live sequence (via the ops script today, the operator-app UI
   when Deliverable D rungs land), watching the watcher, TTL/refund paths (T7).
4. **When the work arrives** — read the deliverable; what `human_fallback`
   review actually is (T5, in plain words: "approving = the arbitrator resolving
   in the worker's favor"); verdict semantics table (`dismissed` = pay,
   `upheld` = reject+slash, `split` = partial).
5. **What your workers face** — the bond (T2), so posters set rewards that make
   the bond worth locking.
6. **What "verified" means today** — v1 honesty: human review by you;
   automated re-derivation (CI-green, diff-non-trivial) is roadmap 2.8. No
   over-promising.
7. **The worked example** — the kana-dojo bounty, end to end, with the #874
   links and the on-chain receipts.

**Acceptance:** a maintainer who has never seen Averray can go from zero to a
funded bounty using only this guide + the enrollment step. Reviewed against
T1–T8; no number in it contradicts a live-read surface.

---

## 4. Deliverable C — operator-app poster surface (rungs; app lane)

Parity mapping of the proven rail. Ship in order; each rung is honest alone.

- **C1 — read-only lens** (no backend delta): "My posted jobs" — drafts with
  live status chips (`awaiting_funding`/`live`/`mismatch`/`expired`), external
  catalog lens (`source: external`, poster badge), deliverable viewer on the
  run detail, settlement row (worker paid / fee / resolution tx). Non-enrolled
  wallets see the surface with the honest T8 banner, not dead buttons.
- **C2 — post + fund** (no backend delta): draft form (task, criteria, repo,
  reward ≥ live floor) → renders the returned funding math (reward, fee,
  total) → hands the draft's calldata to the connected browser wallet
  (approve → deposit → create), then watches the watcher. The wallet that
  SIWE'd in signs — non-custodial by construction.
- **C3 — poster approval** (the one real authz delta, its own PR + threat-model
  note): scoped rule — *a poster may resolve the review of their own job's
  submission*. Backend enforces poster-of-job on the dispute-verdict path for
  `human_fallback` externals (today: admin-role only). UI: submission viewer +
  approve/reject with the verdict-semantics language from B§4. This closes
  full self-serve and gives the human the same act the admin API performs —
  the parity principle's proof case.

**Acceptance per rung:** C1 renders real data for the dogfood poster wallet;
C2 reproduces PR #874's dry-run numbers against a test draft; C3 passes an
authz test matrix (poster-of-job ✓, other-poster ✗, non-poster ✗, admin still ✓)
before any UI ships.

---

## 5. Lanes, order, non-goals

| Piece | Lane | Depends on |
|---|---|---|
| A (+A2, A3) | Codex — one backend PR | nothing (door is live) |
| B | Claude — docs PR | A merged (links + live values named) |
| C1, C2 | app lane (Claude or Codex per availability) — one PR each | A (C1 links its payload); C2 also wants B for help-text |
| C3 | Codex (authz) then app | explicit threat-model sign-off |

Order: **A → B → C1 → C2 → C3.** Go-to-market (friendly maintainers) can start
right after B — the guide plus the ops script is a complete posting path even
before C-rungs land.

**Non-goals (unchanged from the beachhead):** `open` mode (needs the
audit-delta), poster-defined verifier logic, milestone/recurring external jobs,
poster reputation trails, any WYSIWYG job builder beyond C2's form.

---

## 6. Packet acceptance (the "explains itself" bar)

Two clean-room walkthroughs, both documented in the closing PR:

1. **Agent path:** a fresh session given only `https://api.averray.com` +
   `/.well-known/agent-tools.json` discovers `/poster/onboarding`, and (in
   allowlist mode, pre-enrolled) completes draft → fund → live without human
   help — then, as a worker wallet, discovers the bond + preflight from
   `/onboarding` before claiming.
2. **Human path:** a person given only the guide reaches a funded bounty.

Every stated number cross-checked against live reads at walkthrough time.
