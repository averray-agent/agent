# Packet: claimant-pattern guardrails (follow-on to PACKET_PR_OUTREACH_GUARDRAILS)

**DIRECTIVE (implementer):** build this in `averray-agent/agent` as the PRs
below, **one PR each, in the order given**, each from a fresh worktree off
`origin/main`. Do not review or summarise the packet; implement it.
**Nothing here starts until PRs 1–3 of `docs/PACKET_PR_OUTREACH_GUARDRAILS.md`
have merged.** Each PR is gated by Claude before merge, and each guard
listed under "Acceptance" must have a test that fails when the guard is
removed. Pascal approved this on 2026-10-14. The source is the
claimant-pattern proposal of 2026-10-14, built on a read-only analysis of
all 296 JobClaimed events on EscrowCore v3. Its figures are *reported*, not
re-verified; PR A makes the next count exact.

## Global rules

All rules from `PACKET_PR_OUTREACH_GUARDRAILS.md` apply unchanged:
- additive only;
- every new refusal or hold sits behind `*_MODE=log|enforce`, default
  `log`, which emits a `would_*` counter and a structured log line, and is
  switched on later by a separate one-line PR;
- repo identity is the GitHub repository id;
- unmeasured means "not reported", and unknown goes to `ambiguous`;
- no IP, ASN or geo data, and no wallet or handle on public surfaces;
- our own verifier rejections and expired claims never penalise anyone;
- name the consumers before changing any shape;
- never post, comment or label on third-party GitHub repos.

On top of those:
- **A GitHub person is the PR author's numeric GitHub user id**
  (`pull.user.id`) from the GitHub API read that the verifier already
  makes. It is **never** the handle written in a footer, because anyone can
  type any handle. It is not the login either, because logins can be
  renamed (the savedly#91 lesson).
- A wallet becomes linked to a person **only through a verified
  submission** whose PR, read from GitHub, has that author. A wallet with no
  link is `ambiguous` and is never merged with another wallet by guesswork.
- Our own wallets (PR A) are excluded from every external count and
  reported in their own `ours` bucket.

## Decisions (Pascal, 2026-10-14)

- No explicit GitHub sign-in at claim time (proposal "Phase B") for now.
  Linking happens through the first verified PR. Revisit if the abuse
  continues.
- A PR that existed before the claim → **hold for manual review**. It is
  never auto-refused and never paid less.
- Pay on merge: the reserve is released at the job's existing stale date
  (14 days). Re-check the runway impact before switching PR F to enforce.
- The operator reviews sergioprica's and ciperx's **open** sessions by hand
  now. There is no clawback of anything already paid. That is an operator
  task, not code.
- The cross-repo burst warning is an amendment to outreach PR 3, if PR 3
  hasn't merged yet. Otherwise it is PR B below.

---

## PR A: extend the self-identity registry (no new registry)

**Behaviour.**
- Extend the existing `mcp-server/src/core/self-identity-registry.js`
  (#1479: `ARRIVAL_*_WALLETS`, `ARRIVAL_*_API_KEY_IDS`,
  `OPERATOR_VIEWER_WALLETS`). **Do not create a second registry.**
- Add an admin-managed list of our own wallets, each entry
  `{ wallet, label, purpose, addedBy, addedAt }`, with labels such as
  canary, acceptance, qa-engineer, blind-user, dogfood.
  - It is stored in service state and edited through an admin route that
    requires the existing admin capability; every edit is logged.
  - The env lists stay as they are.
- Canary wallets are created fresh on every run, so recognise them by their
  **canary job ids / job tag**, not by a growing wallet list. A claim on a
  canary job is `ours` by construction.
- `github-author-visibility.js`, the burst warnings, waiver counts and the
  counters in PRs C–G exclude `ours` and report it as its own bucket.

**Acceptance:**
- A registry wallet is excluded from external counts and counted in `ours`.
- A canary-tagged job's claimant is `ours` even though its wallet is not in
  the list.
- An empty registry produces byte-identical output to today.
- The admin route requires its capability.
- No registry wallet appears in any public or transparency output.

## PR B: cross-repo claim burst (amendment to outreach PR 3, or a standalone PR)

- Add the warning **`github_lane_claim_burst`** when **3 or more** distinct
  non-`ours` wallets claim `github_issue` jobs within **5 minutes**, across
  any repos.
- Wallets linked to the same person count as one.
- It is a warning only: no throttle, and counts only in the payload.
- Thresholds: `GITHUB_LANE_BURST_WALLETS` (3) and
  `GITHUB_LANE_BURST_MIN` (5).

**Acceptance:**
- 3 wallets in 4:59 → warning; 3 wallets in 5:01 → no warning.
- 2 wallets → no warning.
- A linked pair counts as 1.
- `ours` wallets are ignored.
- No wallet or handle appears in a public payload.

## PR C: footer audit (admin only, read only)

**Behaviour.**
- A backend scheduled job, separate from ingestion, runs hourly with its
  own budget counter. Budget: at most **5 GitHub search calls per hour**
  (`GITHUB_FOOTER_AUDIT_SEARCH_PER_HOUR`, default 5).
  - It must never compete with ingestion or verification. Search has its
    own GitHub rate bucket; still, stop when `x-ratelimit-remaining` is low.
- It searches for PRs that carry the canonical disclosure header and parses
  them with the existing `readAverrayDisclosure`. Each one is classified:
  - **bound:** the named session or wallet has a real claim;
  - **unbound:** no such claim;
  - **ambiguous:** the footer can't be parsed.
- It raises the admin-only warning `github_footer_unbound`, with counts per
  linked person on admin surfaces only.
- Coverage is partial, so completeness is reported as "not reported".
- **No write calls to GitHub, ever.** A test must assert this.
- `GITHUB_FOOTER_AUDIT=off|on` (default on).
- The later review hook is `GITHUB_FOOTER_UNBOUND_REVIEW_MODE=log|enforce`,
  default log: in enforce, a person with ≥ N unbound footers in 30 days
  gets `claim_review_required`.

**Acceptance:**
- Real session → bound; fake session → unbound; malformed → ambiguous.
- The search budget holds.
- The no-write test passes.
- No `0x…{40}` or handle appears in public payloads.
- A raced or failed claim attempt only warns; nobody is punished
  automatically.

## PR D: exposure cap per GitHub person

**Behaviour.**
- At claim time on `github_issue` jobs, resolve the claimant wallet to its
  linked person (the GitHub user id from the rules above).
- Apply the existing exposure limits, open **2.5 USDC** and daily
  **1.50 USDC**, **summed across every wallet linked to that person**.
- An unlinked wallet keeps today's per-wallet limits and counts as
  `ambiguous`.
- `GITHUB_IDENTITY_EXPOSURE_CAP_MODE=log|enforce`, default log, with
  `GITHUB_IDENTITY_OPEN_USDC` = 2.5 and `GITHUB_IDENTITY_DAILY_USDC` = 1.50.
- Error `github_identity_exposure_cap_reached`. Details carry counts only;
  the person's id or handle goes to admin logs only.
- An admin unlink route (capability required, logged) handles stale links.
- Add the PR author's `user.id` and `user.login` to the verifier evidence.
  This is additive and is what the link is built from.

**Acceptance:**
- 3 linked wallets with combined open exposure ≥ 2.5 → the 4th claim is
  logged (log) or refused (enforce).
- An unlinked wallet is unaffected and counted as ambiguous.
- A footer naming another handle creates **no** link; only the API author
  does.
- A renamed GitHub login keeps the link, because it is keyed by user id.
- Log mode never refuses.
- The per-wallet cap still fires on its own.
- The public error body carries no handle or wallet.

## PR E: onboarding waiver once per person

- A wallet linked to a person who has already used the onboarding waiver
  doesn't get it again. Unlinked wallets are unchanged.
- `ONBOARDING_WAIVER_IDENTITY_MODE=log|enforce`, default log, with a
  `waiver_would_deny` counter.
- The monitor or admin view splits waiver use into first, repeat, ambiguous
  and ours. Missing data shows "not reported".

**Acceptance:**
- A person's second wallet → would_deny (log) or no waiver (enforce).
- An unlinked wallet is unchanged.
- `ours` wallets are excluded.
- "not reported" appears when identity data is missing.

## PR F: hold when the PR existed before the claim

- At submission, compare the PR's `created_at` (from the existing evidence
  read; no new GitHub call at claim time) with the session's `claimedAt`.
- When the PR predates the claim by more than
  `PR_PREDATES_CLAIM_GRACE_MIN` (default **10**), stop the session at
  `human_review` with reason `github_pr_predates_claim`. **It holds, never
  rejects and never pays less** (Pascal's decision).
- `PR_PREDATES_CLAIM_MODE=log|hold`, default log.

**Acceptance:**
- A PR created 11 minutes before the claim → flagged; 9 minutes before →
  not flagged.
- A PR created after the claim → unaffected.
- Hold mode moves the session to `human_review`, never to rejected.
- A missing `created_at` → ambiguous, not flagged.

## PR G: pay on merge (last; changes payout timing)

**Behaviour.**
- For `github_pr` jobs, settlement waits until the PR is **merged**, as seen
  by the scheduled reader `services/github-pr-review-service.js` (identified
  in outreach PR 1).
- An evidence-only approval moves the session to `awaiting_merge`, which
  matches the monitor's existing `waitingForMerge`.
- A PR closed without merging releases the reserve with no payout. The
  session is recorded as `closedByMaintainer`, and the outreach PR 2
  cooldown still applies to maintainer closes.
- The reserve is released at the job's stale date (**14 days**) if the PR is
  still unmerged.
- No clawback. Historical cases where we approved and the maintainer later
  closed are only **reported**, as an `approvedThenClosed` count on admin
  and in the outreach PR 5 `prOutcomes` block, kept separate from
  `closedByMaintainer`.
- `GITHUB_PR_SETTLE_ON_MERGE_MODE=log|enforce`, default log, with a
  `would_hold_until_merge` counter.
- Before anyone switches this to enforce, the PR body must show the
  projected reserve against liquid funds: today's backlog awaiting merge,
  and the runway in days.

**Acceptance:**
- Approved evidence with the PR still open → no settlement (enforce) or a
  counter (log).
- A merged PR → settles.
- A PR closed without merge → reserve released, no payout.
- Unknown PR state → held as ambiguous.
- Stale date reached → reserve released.
- Log mode changes nothing.

## Not code (operator / process)

- **Pascal, now:** review sergioprica's and ciperx's **open** sessions by
  hand through the github_pr review lane. No clawback.
- **Outreach to proven single-wallet contributors** (priority window,
  directory) is outbound messaging under the Averray name. It needs
  Pascal's explicit OK each time.
- **Don't build anything on runtime fingerprints.** About 95% report the
  same Node version, so they distinguish nobody.
- **Admin data gaps, for later:**
  - every claim attempt, including refused and raced ones;
  - a SIWE first-seen log (internal);
  - the PR URL in the evidence for every session;
  - per-wallet credit and withdrawal history.

## Order

1. A, the registry extension.
2. B, if outreach PR 3 has merged; otherwise fold it into PR 3.
3. C.
4. D, then E.
5. F.
6. G, last.

All in log mode first. Switching each one to enforce is a separate one-line
PR after 3 days of data.
