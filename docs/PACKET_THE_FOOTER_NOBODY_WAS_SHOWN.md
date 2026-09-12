# PACKET — the footer nobody was shown: two outside workers rejected on chain for a sentence the job never gave them, and no operator path exists to overturn it

Status: ready for implementation. **One PR, this week.** Hard deadline: the
on-chain dispute window of both rejected jobs closes **2026-09-19T23:16:48Z**;
after that anyone can call `finalizeRejectedJob` and slash the workers.
Supersedes the "Live:" paragraph of
`PACKET_GITHUB_PR_SUBMISSIONS_WAIT_FOR_NOBODY.md`; that packet's four fixes
remain part 2 and can land in the same PR or the next one.

## What happened (verified on `origin/main` 26a81c39, the stored verdicts and the chain)

The operator ran the review runsheet I wrote for the two waiting `github_pr`
sessions at 23:16Z on 2026-09-12. `POST /verifier/run` verifies **and settles
in the same call**, so both verdicts went to chain before anyone saw them:

| session | job (chain) | reward | stake / fee | verdict | blockers reported |
|---|---|---|---|---|---|
| `pr-l1uk3-playsouthwales-128:0xaDE2…` | `0xfc11092a…` | 1.0 USDC | 0 / 0 | rejected, score 80 (min 80) | live checks must pass; disclosure footer; disclosure must identify the claimant |
| `real-patch-tricklepay-withdraw-disabled-test-149:0xCdC6…` | `0xfd4fdf36…` | 2.0 USDC | 0.2 / 0.05 | rejected, score 80 (min 90) | disclosure footer; disclosure must identify the claimant |

Both escrows: state `Rejected`, `rejectedAt 2026-09-12T23:16:48Z`,
`rejectingVerifier 0x5a6836…`, stakes locked, nothing slashed
(`JobRejected` in blocks 20579267 / 20579274, reason
`keccak("GITHUB_PR_EVIDENCE_INCOMPLETE")`).

Every blocker is ours, not theirs:

1. **The footer test is an exact sentence the worker never saw.**
   `hasAverrayDisclosureFooter` (`mcp-server/src/core/maintainer-surface-policy.js:170`)
   is `text.includes("This contribution was prepared by an autonomous agent operating on the") && text.includes("Averray platform.")`.
   The job hands the worker only "include the Averray disclosure footer with
   your claimant wallet or claim session" (`getJobDefinition` →
   `agentInstructions[3]`, `acceptanceCriteria[3]`). The template exists only
   on poster surfaces (`poster-onboarding.js:450 footerFormat`,
   `app/lib/api/poster-definition.js`) and in two internal specs;
   `skills/averray-worker/SKILL.md` does not contain the word "disclosure".
   Both PRs carry a disclosure that names Averray, the AI agent, the wallet
   and the session — in their own words.
2. **The binding parser found the session and still said "missing".**
   `inspectAverrayClaimantBinding` (`:181`) matched the TricklePay PR's
   `Claim session: real-patch-…:0xCdC6…` line exactly — the stored verdict
   says `disclosedSessionId = <the session>`, `sessionMatches: true` — and
   returned `status: "missing"` because the header sentence was absent
   (`!footerPresent ? "missing"`). The rejection then told the worker the
   disclosure "must identify the actual claimant wallet or claim session".
   That statement is false for that PR. The playsouthwales PR used
   `Averray claimant wallet: \`0x…\`` / `Averray claim session: \`…\``; the
   regexes accept only `Agent identity:` / `Claim session:` and no backticks.
3. **"Live GitHub checks must pass" was a Vercel authorization prompt.**
   `L1UK3/playsouthwales` has no `.github/workflows`. The single commit
   status is context `Vercel`, state `failure`, and the bot comment on the PR
   says "A member of the Team first needs to authorize it" — a maintainer-side
   fork-deploy gate, not a failed build. `summarizeGithubChecks`
   (`verifier-handlers.js`) turns any combined-status `failure` into
   `ciStatus: "failing"`, which is a hard blocker (`:441`). The same function
   maps a check run with conclusion `action_required` (GitHub Actions waiting
   for maintainer approval of a first-time contributor) to `failing`.
4. **There is no operator path to overturn a wrong rejection.** Off chain,
   `rejected` is terminal (`core/session-state-machine.js:9`); `/disputes`
   lists only sessions in `disputed` (`dispute-routes.js listDisputes`); the
   verdict route finds nothing else. On chain the path exists and is
   already wired for other flows: `openDisputeFor(jobId, participant)`
   (`contracts/EscrowCore.sol:825`, operator-only; brokered by
   `gateway.openDispute`, used by `poster-review-service.js:345` and
   `platform-fault-remediation-service.js:123`) then `resolveDispute(jobId,
   workerPayout, reasonCode, metadataURI)` by the arbitrator (`:894`; payout
   > 0 releases the stake, keeps the post-tier fee, mints the badge, does not
   reward the overturned verifier). The mainnet arbitrator
   `0x7a246c…` is out-of-band hardware, so `resolveArbitrationExecution` is
   `out_of_band_hardware` and the verdict route only converges a job that is
   already `Closed` on chain (`alreadyResolvedOnChain`). The platform-fault
   remediation cannot be used after the fact: it starts from a
   `platform_fault` verdict in escrow state `Submitted`
   (`platform_fault_remediation_checkpoint_missing` otherwise).
5. **There was no way to look before settling.** `/verifier/run` has no
   preview. I predicted the verdicts from the score table instead of running
   the handler's own checks against the PR bodies I already had.
6. The playsouthwales catalogue row is gone (`getJobDefinition` →
   `job_not_found`; the backend was recreated for #1375 at ~23:05Z and the
   ingest did not re-list it). The session still carries its job snapshot.
   Anything in this packet must work from the session's snapshot, not the
   catalogue.

## The fix

1. **Operator overturn.** `POST /admin/sessions/overturn {sessionId, rationale}`
   (admin role). Preconditions: local session `rejected`; chain job
   `Rejected` with `now ≤ rejectedAt + DISPUTE_WINDOW` (otherwise
   `409 overturn_window_closed` naming the end time); chain worker equals the
   session wallet. Action: `gateway.openDispute(chainJobId, session.wallet)`,
   assert chain state `Disputed`, then transition the session
   `rejected → disputed` with reason `platform_fault_operator_overturn` and
   `metadata.origin = "operator_overturn"`. The state machine allows
   `rejected → disputed` **only** with that origin. Idempotent: chain already
   `Disputed` + local `rejected` converges local state only; local already
   `disputed` replays. The dispute then appears in `/disputes` with
   `origin: "operator_overturn"`, `workerInitiated: false`, the rationale, and
   the existing `arbitration.execution` semantics; the public event is
   `platform.overturn_dispute_opened` (mirror the remediation nuance at
   `blockchain/event-listener.js:211`: never project the brokered participant
   as a worker-initiated dispute). From there the existing arbitration flow
   applies unchanged: hardware `resolveDispute`, then the verdict route's
   receipt convergence moves the session to `resolved`. After a payout
   verdict the agent profile, directory and `/verifier/result` must show the
   session as resolved with the payout and the overturn, and must not count
   it as a rejection; the original verdict stays readable as history.
2. **The binding is the requirement; the sentence is a template.**
   `inspectAverrayClaimantBinding` returns `matched` whenever the wallet or
   session line matches, regardless of the header sentence. Accepted labels,
   case-insensitive, optional leading `Averray`, surrounding markdown
   (`*`, `_`, `>`, `-`, backticks) ignored: `Agent identity`, `Claimant
   wallet`, `Claim session`, `Session`. Values may be wrapped in backticks.
   The exact-match rule is unchanged and an unlabelled address anywhere in
   the body still does not bind (security property). `hasAverrayDisclosureFooter`
   is true for the canonical header **or** a labelled claimant line plus the
   word "Averray" anywhere in the body. Blocker texts: "must identify the
   claimant" may only be emitted when no labelled line was found;
   "must match" only when one was found with a different value. The verdict
   records `disclosure: { canonicalHeader, labelledLines, matchedBy }` so a
   rejection can be audited from `/verifier/result`.
3. **Only CI is CI.** In `summarizeGithubChecks`: a check run with
   conclusion `action_required` is `pending_maintainer_approval` →
   `ciStatus: "unknown"`, never `failing`. A combined-status context whose
   description matches `/authoriz/i`, or whose context names a deployment
   integration (`vercel`, `netlify`, `render`, `cloudflare pages`) and has
   no check runs behind it, is excluded from the CI decision and listed on
   the verdict as `ciExclusions: [{context, description, reason}]`. A real
   failed check run or a failed status from anything else stays `failing`.
4. **Hand the worker the footer.** `getJobDefinition` for `github_pr` jobs
   returns `disclosure: { required, canonicalFooter, acceptedClaimantLines,
   rule }` with the exact text; the claim response (`POST /jobs/claim`,
   MCP `claimJob`) returns `disclosureFooter` with the wallet and session
   already filled in, ready to paste. `POST /jobs/validate-submission` for a
   `github_pr` job that includes `prBody` runs the parser against the
   caller's wallet/session and answers `disclosure: { status, hint }`, with
   `submitSafe: false` and code `disclosure_binding_missing` when the status
   is `missing` or `mismatched`; without `prBody` it answers
   `status: "not_checked"` and the footer text in `hint`. `SKILL.md` gets a
   "Disclosure footer" section with the exact template and the binding rule.
5. **Preview before settling.** `POST /verifier/run {sessionId, preview: true}`
   runs the same handler and returns the full verdict (`outcome`, `score`,
   `blockers`, `checks`, `githubLookup`, `disclosure`, `ciExclusions`)
   and persists nothing: no verdict record, no session transition, no chain
   write, no event. The ops script from part 2
   (`scripts/ops/review-github-pr-submissions.mjs`) gets `--preview
   <sessionId>` and `--settle <sessionId> --expect <outcome>`; `--settle`
   previews first and refuses (exit 2, verdict printed) when the preview's
   outcome differs from `--expect`.

## Non-negotiables (each pinned by a test; I run the drills)

1. TricklePay-shaped body (no header sentence, exact `Claim session:` line)
   → `matched`, no disclosure blocker, no claimant blocker. Mutation: restore
   the `!footerPresent ? "missing"` branch — must fail.
2. playsouthwales-shaped body (`Averray claimant wallet: \`0x…\`` /
   `Averray claim session: \`…\``) → `matched`. Mutation: drop backtick
   stripping — must fail.
3. A body with the right wallet in prose but no labelled line → `missing`.
   Mutation: match unlabelled addresses — must fail.
4. Vercel authorization `failure` with no check runs → `ciStatus unknown`,
   exclusion recorded; a failed `check_run` → `failing`; `action_required` →
   `unknown`. Mutation: treat every status failure as CI — must fail.
5. Overturn: local `rejected` + chain `Rejected` inside the window →
   `openDisputeFor` sent, chain `Disputed`, session `disputed` with origin;
   one second after the window → 409 with the end time and no chain call;
   chain already `Disputed` → local converge only; catalogue row absent →
   still succeeds from the session snapshot. Mutation: allow `rejected →
   disputed` without the origin — must fail.
6. Preview: after `preview: true`, `/verifier/result` is unchanged, the
   session status is unchanged, the gateway spy saw no call, the event bus
   saw nothing. Mutation: remove the persistence guard — must fail.
7. After an overturned session resolves with payout, the agent profile shows
   no rejection for it and the verifier result shows both the original
   verdict and the overturn. Mutation: count the historic `rejected` status —
   must fail.
8. `validate-submission` with a `prBody` lacking a labelled line →
   `submitSafe: false`, hint contains the canonical footer. Mutation: return
   `submitSafe: true` — must fail.
9. `SKILL.md` contains the canonical footer and the binding rule; a test
   greps both. Mutation: drop the `Claim session:` line — must fail.

## Live remediation (operator, after deploy, before 2026-09-19T23:16:48Z)

1. Preview both sessions. Expected under the corrected rules:
   playsouthwales `approved` 80/80 with no blockers; TricklePay
   `human_fallback` (80/90, checks unknown while the upstream Actions run
   awaits maintainer approval).
2. `POST /admin/sessions/overturn` for both. Both escrows move to
   `Disputed`; the slash clock stops; `ARBITRATOR_SLA` (14 days) starts.
3. Arbitration ceremony (hardware arbitrator `0x7a246c…`, the method in the
   arbitrator-ceremony runbook): `resolveDispute(0xfc11092a…, 1000000, …)`
   and `resolveDispute(0xfd4fdf36…, 2000000, …)` — full payout is my
   recommendation for both; TricklePay is the operator's human-review call
   after reading PR #219.
4. `POST /disputes/:id/verdict` for each (receipt convergence, no signer
   needed once `Closed` on chain) → sessions `resolved`; check
   `/verifier/result`, both agent profiles and `/pool`-independent treasury
   reads (fee 0.05 from the TricklePay claim lands in treasury as on any
   successful claim).
5. If the PR is not deployed by 2026-09-18, open both disputes on chain
   anyway (operator signer `openDisputeFor`, or the workers' own
   `openDispute`) — that alone prevents the slash and keeps full payout
   available; the local sessions are converged by the overturn route once it
   lands.

## Out of scope

Score weights and minimums; making `github_pr` auto-decidable; paying
without an arbitrator verdict; any change to the claim stake rules.
