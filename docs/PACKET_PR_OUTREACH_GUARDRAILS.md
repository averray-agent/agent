# Packet: PR outreach guardrails — repo caps at claim time, maintainer cooldown, opt-in, public merge rate

**DIRECTIVE (implementer):** build this in `averray-agent/agent` as the
seven PRs below, **in order, one PR each**, from a fresh worktree off
`origin/main` per PR. Do not review or summarise the packet; implement it.
Each PR is gated by Claude before merge. Each guard listed under
"Acceptance" must have a test that fails when the guard is removed: the gate
mutates the guards. Pascal approved this packet on 2026-10-14.
Proposal source: the PR-outreach proposal of 2026-10-14. Decisions taken
there are recorded under "Decisions".

## Global rules (every PR)

- **Additive only.** Existing response fields, error codes, enums and
  defaults keep their current meaning. A new behaviour that refuses
  something ships behind an env flag that defaults to **log-only**
  (`would_refuse` counter plus a structured log line). It is switched to
  enforce by a separate one-line config change after 3 days of data.
- **Truth boundary.** Unmeasured means `"not reported"`, never 0. Unknown
  attribution stays in an `ambiguous` bucket and is never guessed.
- **Privacy.** No IP hashing, ASN, country or geo data. No wallet addresses
  or GitHub handles in any public surface.
- **Repo identity is the GitHub repository id**, never the name. A rename
  must keep caps, cooldowns and opt-in state. This is the savedly#91 lesson
  and #1485. Where an old record has only a name, resolve it through the
  existing pin and identity services, and treat it as unknown if that fails.
- **Name the consumers.** Before changing any default, response shape or
  error code, grep `app/`, `scripts/ops/`, `.github/workflows/`,
  `mcp-server/src/protocols/mcp/tools.js`, `discovery/`, `sdk/` and
  `docs/`. List in the PR body each consumer and what it does with the
  change. Today `maintainer_open_pr_cap_reached` has no consumer outside
  `job-execution-service.test.js`.
- **Checks:** `npm --workspace mcp-server test`, plus `npm run test:ops`
  when scripts change, plus `npm run build:site` when `marketing/` changes.
  PR notes follow AGENTS.md.

## Verified state on main (`02ff2bda`, 2026-10-11)

- `DEFAULT_OPEN_PR_CAP_PER_REPO = 3` (`maintainer-surface-policy.js:1`) is
  enforced **only at submission**: `enforceMaintainerOpenPrCap`
  (`job-execution-service.js:1510`, called at `:1170`) uses
  `countOpenGithubPullRequestsForRepo`. `claimJob` (`:125`) never reads the
  repo. Ingestion only *records* `openPrCap` on
  `source.maintainerPolicy` (`ingest-github-issues.js:222`) and enforces
  nothing. Env: `MAINTAINER_OPEN_PR_CAP` / `GITHUB_INGEST_OPEN_PR_CAP`
  (`github-issue-ingestion-scheduler.js:342`).
- No cooldown exists in the maintainer policy.
- "Closed without merge" is observed at `verifier-handlers.js:481`, but only
  when verification runs, which for `github_pr` is operator-triggered.
  Candidate periodic readers: `services/upstream-status-poller.js`
  (funded jobs) and `core/github-review-disposition.js`. Find out which, if
  any, reads the PR state of **submitted** `github_pr` sessions on a
  schedule. If none does, PR 2 adds a bounded read to the ingestion
  scheduler tick.
- Per-wallet exposure caps already exist: open 2.5 USDC, daily 1.50 USDC
  (see `docs/WORKER_PROGRESSION_DESIGN.md`). So damage across repos is
  bounded per wallet. Only a multi-wallet operator gets past them, which is
  what PR 3 detects.
- Observed 2026-10-14 03:47–03:48 Zurich: three wallets claimed
  `redux-space/atraport-api` #51, #63 and #69 within one minute.

## Decisions (Pascal, 2026-10-14)

- Caps: **2** open items per repo with no merged Averray PR, **3** after the
  first merge, **5** for opted-in repos. "Open items" means open PRs plus
  active claims.
- Cooldown: **7 days** after a maintainer closes a PR without merging,
  **30 days** for a second close within 30 days, and **indefinite** on a
  stop signal until an operator clears it.
- Our own verifier's rejections and expired claims do **not** start a
  cooldown. Our verifier has rejected wrongly before (the 2026-09-12 footer
  bug), so a maintainer must not be penalised for our mistake. A PR we
  rejected that is still open on GitHub keeps counting toward the cap until
  it closes.
- Footer: **one** added line. 3B (promotional comments on merged PRs) is
  **dropped**.
- `/transparency`: repos with fewer than 3 resolved PRs are grouped into
  "other". Maintainer-closed and Averray-rejected outcomes are separate
  counts.

---

## PR 1: claim-time repo cap

**Behaviour.**
- On `claimJob` for a `source.type === "github_issue"` job, compute
  `openPrs + activeClaims` for the job's repository id. Refuse with
  `ConflictError` code **`maintainer_repo_claim_cap_reached`**, details
  `{ repoId, repo, openPrs, activeClaims, cap }`, when the total is at or
  above the cap.
- The cap is the tier decided above: 2, 3, or 5 when opted in (PR 4 sets
  opt-in; until then the tiers are 2 and 3).
- **Atomicity:** take a per-repo-id lock around the count and the claim
  write, using the same lock mechanism as the existing per-job claim lock.
  Concurrent claims must not get past the cap.
- `activeClaims` counts claims that have not expired and have not submitted.
  An expired claim frees its slot at once, with no sweep needed.
- Keep the submit-time check (`:1510`) unchanged as the backstop.
- Flag `MAINTAINER_REPO_CLAIM_CAP_MODE=log|enforce`, default **`log`**:
  - **log:** never refuse. Emit `maintainer_repo_claim_cap_would_refuse`,
    a structured log line plus a counter that is visible on `/admin/status`
    or the existing ops counters.
  - **enforce:** refuse.
- Also add `MAINTAINER_REPO_CAP_NO_MERGE` (2), `MAINTAINER_REPO_CAP_MERGED`
  (3) and `MAINTAINER_REPO_CAP_OPTED_IN` (5) to
  `deploy/backend.env.template` (then regenerate the mainnet template with
  `scripts/ops/render-mainnet-backend-env.mjs`) and to
  `mcp-server/.env.example`.

**Data.** "Has a merged Averray PR" is derived from existing sessions and
verifications for the repo id. Do not add a new store unless it is needed.
If you add one, key it by repo id.

**Acceptance (each guard RED when removed):**
- 1 open PR + 1 active claim on a no-merge repo → the third claim is
  refused (enforce) or logged (log).
- A repo with a merged PR allows a third item and refuses a fourth.
- Two concurrent claims when one slot is free → exactly one succeeds.
- An expired claim frees its slot.
- A renamed repo (same id, new name) keeps its count.
- Log mode never refuses and increments the counter.
- The submit-time backstop still fires.
- Non-GitHub jobs are unaffected.

## PR 2: maintainer cooldown

**Behaviour.**
- When a PR for a repo is observed **closed without merge**, set the
  repo-id record `{ repoId, fullName, cooldownUntil, cooldownReason,
  lastMaintainerCloseAt, closeCount30d }`:
  - first close → now + 7 days;
  - a second close within 30 days → now + 30 days;
  - stop signal → `cooldownUntil: "indefinite"` (cleared only by an
    operator).
- The signal comes from the existing observation at
  `verifier-handlers.js:481` and from the periodic reader found above, or
  the new bounded read in the ingestion tick if none exists.
- Our verifier's rejections, expired claims and claims without a PR do not
  set a cooldown.
- While a cooldown is set:
  - ingestion skips the repo, and records the skip reason in the ingest
    summary;
  - `claimJob` refuses with **`maintainer_repo_cooldown`** (details:
    `cooldownUntil`, `reason`). This is behind the same log/enforce flag
    pattern: `MAINTAINER_REPO_COOLDOWN_MODE`, default `log`.
- `MAINTAINER_REPO_COOLDOWN_DAYS` (7) and
  `MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS` (30) are configurable.
- Operator clear: an admin route (`ops:manage` or the existing admin
  capability) that clears a repo's cooldown, with the actor and reason
  logged. It is not public.

**Acceptance:**
- A first maintainer close sets 7 days; a second within 30 days sets 30.
- A stop signal sets indefinite, and only the operator route clears it.
- Our own rejection with the PR still open sets no cooldown, but still
  counts toward the cap.
- An expired claim sets nothing.
- A renamed repo keeps its cooldown.
- Ingestion skips the repo.
- Log mode never refuses.
- The clear route requires its capability.

## PR 3: burst warning and self-merge hold

**Behaviour.**
- Next to `github_author_concentration` in
  `services/github-author-visibility.js`, add the warning
  **`github_repo_claim_burst`** (severity `warning`). It fires when **2 or
  more distinct wallets** claim jobs in the same repo id within **10
  minutes**. The details are counts and repo only; wallets go only to
  admin surfaces.
- After submission, link claims through existing data: the same PR author
  across wallets (`distinctWallets` per author exists) gives
  **`same_author_multi_wallet`**. If the PR author is unknown, the claim
  goes in `ambiguous` and nothing is guessed.
- **Self-merge hold:** when the user who merged the PR is the PR author,
  or is the repo owner and is linked to the claimant (same author, or a
  wallet already linked to that author), auto-settlement for that session
  stops at `human_review` with the reason
  `github_pr_self_merge_review`.
  - This holds the payout; it does not reject.
  - It applies to every `github_pr` session, not only opted-in repos.
- No automatic slashing anywhere.

**Acceptance:**
- 2 wallets in 9 minutes → warning; 2 wallets 11 minutes apart → no
  warning.
- An unknown author → ambiguous, never linked.
- A merger who is the PR author → `human_review`, not `approved`.
- A maintainer merge by an unrelated account → unchanged.
- Existing `github_author_concentration` tests are untouched.

## PR 4: opt-in label and the single footer line

**Behaviour.**
- `buildAverrayDisclosureFooter` (`maintainer-surface-policy.js:149`) adds
  **one** line after the existing block. The canonical header, the
  claimant wallet and session lines, and `readAverrayDisclosure` parsing
  do not change:
  > `Maintainers: label issues averray-bounty to invite more help like this, or fund your own at averray.com/maintainers.`
  - The footer goes on new claims only.
  - All existing fixtures in
    `core/__fixtures__/github-pr-disclosures.json` must still bind. Add
    fixtures with the new line.
- Ingestion:
  - Add `averray-bounty` to `POSITIVE_LABEL_SCORES` with score 60.
  - Add an extra query pass for `label:averray-bounty`.
  - Record `source.selectionSignal` as `"averray-bounty" |
    "good-first-issue" | "help-wanted" | "other"`. This is an additive
    field.
- Opt-in: a repo id with at least one open issue labelled `averray-bounty`
  is `optedIn: true` with `optedInAt`, which gives cap 5 in PR 1.
  - When the label disappears from all issues, the repo goes back to
    `optedIn: false`.
  - A stop signal and a cooldown always win over opt-in.
- **Anti-farming conditions.** Opt-in only counts when **all** of these
  hold, and otherwise the repo stays on the normal tier:
  - the repo is at least **90 days** old;
  - it has at least **10 stars**;
  - it is not archived;
  - opted-in payouts for the repo stay under a per-repo daily cap,
    `MAINTAINER_OPTED_IN_DAILY_USDC`, default **3 USDC**;
  - PR 3's self-merge hold is active.
- `docs/MAINTAINER_OUTREACH_KIT.md` documents the label.

**Acceptance:**
- Old fixtures bind.
- The new line is present, and the parser ignores it.
- Label precedence is 60 > 30 > 20.
- `selectionSignal` is recorded.
- Removing the label clears opt-in.
- A young or low-star repo with the label is not opted in.
- The per-repo daily cap is enforced.
- A stop signal beats opt-in.

## PR 5: merge rate on `/transparency`

**Behaviour.**
- Add an additive `prOutcomes` block to `averray.transparency.v1`, built
  in `services/transparency-service.js` with the existing
  `toField` / `deriveFieldStatus` freshness. There is no version bump and
  the existing keys stay byte-identical.
- For each window (last 30 days, and all retained history), totals plus
  per-repo rows:
  - `merged`;
  - `closedByMaintainer`;
  - `rejectedByAverray`;
  - `open`;
  - `ambiguous`;
  - `mergeRate = merged / (merged + closedByMaintainer)`, shown as
    `"not reported"` when the denominator is 0;
  - the `selectionSignal` mix;
  - `optedIn`.
- Repos with fewer than 3 resolved PRs (`merged + closedByMaintainer +
  rejectedByAverray`) are folded into one `other` row.
- No wallets, handles, IP or geo. The repo full name and id are public.
- The page section goes in `marketing/public/transparency-reader.js` (a
  follow-up commit in the same PR is fine). The marketing allow-lists
  apply: see the public record page notes; two allow-lists gate new public
  content.
  - No comparison with other projects' numbers on the page.
- Check whether `/transparency` is in `public-openapi-contract.js`; if it
  is, extend the contract additively.

**Acceptance:**
- An old-keys snapshot is byte-identical.
- Empty → `"not reported"`.
- Ambiguous is kept separate.
- `rejectedByAverray` never counts in `mergeRate`.
- A small repo goes into `other`.
- No `0x[0-9a-f]{40}` anywhere in the block.
- The page renders "not reported" for missing fields.

## PR 6: MCP / agent-tooling sourcing track

**Behaviour.**
- A second ingestion query next to `DEFAULT_QUERY`:
  - topics `mcp`, `model-context-protocol`, `mcp-server`, `ai-agents`,
    `agent-framework`, `x402`;
  - at least 50 stars, pushed within 30 days, not archived, license
    present, CI present;
  - the existing policy scan still applies.
- Label preference is `averray-bounty` > `good first issue` >
  `help wanted`. `NEGATIVE_LABELS` are kept.
- Record `source.sourcingTrack: "mcp-agent-tooling"`.
- Share cap: at most **40%** of open jobs come from this track.
- Competitors' repos are excluded through a config denylist.
- Flag `GITHUB_INGEST_MCP_TRACK=off|dry-run|on`, default **`dry-run`**.
  Dry-run prints the candidate list to the ingest summary without listing
  any job. The operator reviews that list before switching it on.

**Acceptance:**
- The query is built correctly.
- The share cap holds.
- The policy scan still refuses a repo with no-AI rules.
- Dry-run lists nothing.
- The competitor denylist is respected.

## PR 7: `averray.com/maintainers` landing page

**Behaviour.**
- A static marketing page, linked from the PR 4 footer line, that says:
  - who funded the work;
  - how to label issues `averray-bounty`;
  - how to fund your own (link to `docs/POSTER_GUIDE.md` and poster
    onboarding).
- It is honest that self-posting needs a wallet, SIWE and three
  transactions until the x402 poster ramp is enabled. The offer is "point
  us at an issue, we fund it", with Pascal answering.
- A `?repo=owner/repo` parameter may be read for display only. There is no
  analytics beyond an aggregate visit count, and the funnel stages that
  aren't measured show "not reported".
- Both marketing allow-lists are updated.

**Acceptance:**
- `npm run build:site` is green.
- The page is in both allow-lists.
- No third-party trackers.
- The footer link resolves.

## Rollout

1. PRs 1 to 3 merge with their flags in `log` / dry-run mode.
2. After 3 days, the operator reviews the `would_refuse` counters and the
   burst warnings, and switches PR 1 and PR 2 to `enforce`. That is a
   one-line template change in its own PR.
3. PR 4 and PR 7 ship together, so the footer link does not point at a 404.
4. PR 5 ships whenever ready.
5. PR 6 is switched on only after the dry-run list is reviewed.

## Metrics

- Refusals at submission → 0, since claims are refused earlier.
- Repos with a maintainer close followed by another Averray PR within
  7 days → 0.
- Repos opted in per month.
- Share of merged PRs that came from invited issues.
- Monthly merge rate on `/transparency`.
