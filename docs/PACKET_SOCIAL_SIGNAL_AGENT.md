# Packet — social signal agent (Averray X account)

**Strategy:** [`DISTRIBUTION_STRATEGY.md`](DISTRIBUTION_STRATEGY.md) — Priority 3, "recent content / sustaining flow"
**Owner:** Codex implements · Claude gates · Pascal operates and approves every post
**Status:** v0.2 — **step 1 built and verified against production.** Steps 2–6 open.
**Account:** `@averray` (brand account, X Premium — individual tier, blue check)

## Goal

The Averray X account posts **only when the system did something real**, always with a
receipt, and **never without Pascal approving that specific post**.

The problem being solved is not "write tweets." It is that the interesting things Averray
does — a first external poster, a measured friction number, an adversarial run that found
something — happen and then nobody notices, because noticing is a manual chore that
competes with shipping. This agent is the noticing.

It is a **signal→draft→approve** pipeline. It is not a content generator, and the
difference is load-bearing: a generator produces posts on a schedule and invents reasons;
this produces posts when a threshold fires and produces **nothing** when none does. An
empty sweep is a correct, expected, common outcome.

## Hard constraints

**1. The transparency payload is the veto, not just the source.**

`GET /transparency` ([`transparency-routes.js`](../mcp-server/src/protocols/http/transparency-routes.js))
is public, uncached beyond 15s, and derived from state anyone can read on-chain. Every
draft carries a `claim` and a `checkedAgainst` snapshot. **If the claim contradicts the
live payload, the agent kills the draft itself — it never reaches Pascal.**

The specific trap this exists to prevent: `composition24h.external` is currently `0`, and
it says so publicly. Any draft implying outside agents are working — "agents are earning
on Averray," "the network is picking up jobs" — is false *and* trivially checkable by a
reader hitting the same endpoint the page uses. The agent must fail that draft closed.

This is the truth boundary from the rest of the codebase applied to a new surface: **the
same endpoint that would prove the claim is the one that vetoes it.**

**2. No autonomous publishing. Ever.**

The agent drafts and queues. A human approves each post individually. There is no
"auto-approve trusted signals" mode, no batch approve, no scheduled release of a
pre-approved queue older than 24h (a stale approval is not an approval — the system may
have changed under it).

**3. No automated engagement. Posting our own content only.**

X's automation rules permit automated posting of your own content. They prohibit bulk
follow/unfollow, auto-DM, auto-like, and mass or duplicate replying. The agent does not
touch the follow graph, does not DM, and does not reply. See "Replies" below for what it
*may* do.

**4. Revenue stays off this surface.**

Platform and founder revenue are Hermes-only — internal ops board, never a public surface.
That rule does not relax because the number is flattering. Post job counts, settlement
counts, friction percentages, and measured costs; never platform take, treasury balance as
income, or anything framed as what Averray earns.

**5. Writes are nearly free. Reads are the cost. Links cost 13×.**

X moved to pay-per-use in February 2026; the free tier is gone and Basic/Pro are closed to
new signups. Current rates: **$0.015 per post, $0.20 per post containing a link, $0.005
per read** (capped 2M reads/month).

The cost model that follows:

| Usage | Monthly cost |
|---|---|
| 30 link-free posts | ~$0.45 |
| 30 posts each with a link | ~$6.00 |
| 500 reads/day (reply-target sweep) | ~$75.00 |

Posting is a rounding error. **Reading is the entire budget.** Design accordingly: the
agent writes freely and reads as little as possible. Do not build a mentions-monitoring
loop in v1 — it is 100× the cost of the thing that creates the value.

The 13× link surcharge points the same direction the algorithm already does: **prefer
native long-form over a link out.** Premium allows 25,000-character posts. Put the
substance in the post; make the receipt link optional and second.

## What counts as a signal

The threshold matters more than the source. A signal that fires every day is not a signal.

| # | Signal | Source | Fires when | Receipt |
|---|---|---|---|---|
| 1 | First external poster | `/transparency` → `composition24h.external` | transition `0 → ≥1`, **once** | tx hash + `averray.com/transparency` |
| 2 | Settlement milestone | `/transparency` → `jobsSettled` | crosses 10/50/100/500/1000 — crossing only, never "we're at 43" | transparency link |
| 3 | New measured number | a `docs/` measurement lands | PR carries the `social:` label | the doc + the figure |
| 4 | First fee of a new kind | chain event | first occurrence only | tx hash |
| 5 | Adversarial run | new `docs/ADVERSARIAL_RUN_*.md` | file added | the doc, findings included |
| 6 | Shipped capability | merged PR | PR carries the `social:` label | PR link |

**Signals 3 and 6 are human-triggered by design.** The agent is bad at judging which code
change is interesting, and confidently wrong in a way that produces filler. A label on the
PR is a one-second human decision that removes the entire failure mode. The agent's job
there is drafting, not selecting.

**Signals 1, 2, 4, 5 are edge-triggered.** Store the last-fired state. A milestone that has
fired never fires again. This is what stops the account posting the same "100 jobs
settled" three days running.

## Draft contract

Each draft is a JSON object. The agent produces 2–3 `variants` per signal.

```json
{
  "signalId": "jobs-settled-100",
  "firedAt": "2026-08-10T07:17:00Z",
  "claim": "100 jobs have settled on Averray mainnet",
  "receipt": {
    "kind": "transparency",
    "url": "https://averray.com/transparency",
    "txHash": null
  },
  "checkedAgainst": {
    "endpoint": "/transparency",
    "readAt": "2026-08-10T07:17:02Z",
    "jobsSettled": 100,
    "composition24h": { "external": 0 }
  },
  "variants": [
    { "text": "...", "linkFree": true,  "chars": 780 },
    { "text": "...", "linkFree": false, "chars": 240 }
  ],
  "vetoed": false,
  "vetoReason": null
}
```

Rules on the contract:

- `checkedAgainst` is a **snapshot, not a reference.** It records the values the claim was
  true against, so an approval reviewed an hour later can be re-validated rather than
  trusted.
- At least one variant must be `linkFree: true`. That is the cheap one and the one the
  algorithm favours; the linked variant is the fallback when the receipt genuinely cannot
  be described in text.
- A vetoed draft is **retained, not deleted**, with its `vetoReason`. The veto log is the
  evidence that the boundary is holding. A sweep that vetoes everything is a good sweep.

## Voice

The account is brand-named but must read as authored by a person. Corporate-plural voice
on a 0-follower technical account reads as a press release and is ignored.

- "I measured X" / "we shipped X" — not "Averray is pleased to announce."
- Lead with the number or the surprise, not the framing.
- Specific beats impressive: *"friction was 0.202% at scale versus ~21% on dust — same
  absolute cost"* beats *"Averray achieves industry-leading efficiency."*
- Post the failures too. The adversarial run that found real problems is better content
  than the run that found nothing, and it is the only kind of post that buys credibility
  for the successes.

## Architecture

### What is deterministic and what is the agent

Settled during the step 1 build. **Threshold arithmetic and the veto are not Hermes's
job.** "Has `jobsSettled` crossed 100" is arithmetic, and the veto is the truth boundary —
neither may be an LLM's opinion, and neither becomes more correct for being reasoned about.
They live in a plain script with unit tests.

Drafting is a genuine language task and belongs to Hermes. The split is therefore:

| Concern | Where | Why |
|---|---|---|
| Read `/transparency`, evaluate thresholds, apply the veto | `scripts/ops/social-signal-sweep.mjs`, this repo | must be deterministic and testable |
| Turn a fired signal into 2–3 post variants | Hermes, `averray-reference-agent` | language, judgment, voice |
| Approval card, recorded approval | Buzz | already the control plane |
| Re-validate and publish | Hermes tool | needs the approval record |

Step 1 needs **no VPS, no SSH, no Hermes**: `/transparency` is public, so the runner reads
it directly. Only steps 2–4 move onto the Hermes lane, and they inherit its scheduling,
correlation and evidence conventions when they do — see
[`HERMES_OPERATOR_REPORTS.md`](HERMES_OPERATOR_REPORTS.md) §3, which already solved
scheduling, evidence, correlation and timeout.

### Step 1, as built

- **Script:** [`scripts/ops/social-signal-sweep.mjs`](../scripts/ops/social-signal-sweep.mjs)
  — 23 unit tests in the sibling `.test.mjs`, run by `npm run test:ops`
- **Workflow:** [`.github/workflows/social-signal-sweep.yml`](../.github/workflows/social-signal-sweep.yml)
  — daily at `07:43 UTC`, deliberately after the `07:17` operator report so a sweep never
  races a report it might want to quote
- **Evidence:** artifact `social-signal-sweep-<run>-<attempt>` (90d) plus a step summary
  carrying the fired claims, the vetoed ones with reasons, and the raw observed values
- **State:** committed at
  [`scripts/ops/social-signal-state.json`](../scripts/ops/social-signal-state.json)

### Why state is committed rather than cached

A lost cache is indistinguishable from a first run, and a sweep that thinks it is running
for the first time will re-announce every threshold ever crossed. Committing the state
makes that failure impossible and leaves the announcement history reviewable in git.

Two behaviours follow from it:

- **The first run calibrates and announces nothing.** On a cold start every already-crossed
  threshold looks new; announcing them would open day one with months-old news presented as
  fresh. The first sweep advances state, reports what it seeded, and stays quiet.
- **State advances by hand, as part of approving.** A fired signal repeats daily until the
  state bump is committed. That is noisy but visible and safe — nothing publishes on its
  own — and the human is already in the loop. **This must harden before step 4**: once
  publishing is wired, a repeat is no longer harmless.

### Truth-boundary review of step 1

The step 1 build was reviewed against the six-state rule and **three conflations were found
in it and fixed.** They are recorded here because each one is the kind of bug that hides the
next one, and because the fixes are load-bearing rather than cosmetic.

| # | Conflation | What an operator would have wrongly concluded | Fix |
|---|---|---|---|
| 1 | empty-no-data vs **empty-degraded** | A `200` carrying a useless body produced `quiet: true`, zero fired, zero vetoed — byte-identical to a genuinely quiet day, and the summary called it "the correct outcome" | `assessPayload()` runs before any evaluation; a payload whose schema version is wrong, or whose every dependency field is missing, is `degraded` — it evaluates nothing, writes evidence, and exits non-zero |
| 2 | first run vs **unreadable state** | `readState` caught every error, so a corrupt state file looked like a fresh start — and a fresh start silently overwrote the record of what had already been announced | only `ENOENT` is a first run; a parse error or any other read error throws and leaves the file intact |
| 3 | quiet vs **suppressed** vs **seeded** | The step summary printed "Nothing to say today. This is the common and correct outcome" on days where signals fired and were vetoed, and on runs that seeded | the summary branches on `payload`/`fired`/`seeded`/`vetoed` and states plainly when a run is *not* a quiet day |

Finding 1 also drove a workflow change: the summary step no longer runs under `set -e`, so a
sweep that dies still writes a summary. A run that produced no evidence file at all now
reports **UNREADABLE** rather than rendering as silence.

The general shape, worth keeping in mind for steps 2–4: **an empty result set is never
self-evidently good news.** Every "nothing happened" needs a proof that the reader worked.

### Claim wording rule

Milestones say **"passed N"**, never "N have settled". The live count is almost always above
the milestone by the time a sweep sees it — production crossed 100 while reading 142 — so a
claim of exactly N would be false against the very field it rests on. There is a test
pinning this.

### Mirrors the existing lane

- **Workflow:** `.github/workflows/social-signal-sweep.yml`
- **Trigger:** daily `schedule`, plus `workflow_dispatch` with `signal_id` for a forced
  re-draft
- **Invocation:** Hermes via the existing `ssh … docker compose exec -T hermes` path.
  Hermes lives in `averray-reference-agent` on the VPS, not in this repo.
- **Correlation ID:** `github-social-sweep-${run_id}-${run_attempt}`
- **Timeout:** `SOCIAL_SWEEP_TIMEOUT=12m`, matching the sibling workflows
- **Evidence:**
  1. Workflow artifact — `drafts.json` (including vetoed drafts) plus the full log
  2. `$GITHUB_STEP_SUMMARY` — signals fired, drafts produced, drafts vetoed with reasons
  3. Hermes-container audit trail under the same correlation id
- **Deny list**, stated in the invocation the way the operator-report job already does:
  do not claim jobs, do not submit work, do not mutate GitHub, do not post to X, do not
  follow/DM/like/reply, do not touch the follow graph.

**Approval:** Buzz card — approve / edit / kill. Publishing is a separate Hermes tool that
**only accepts a draft id carrying a recorded approval**, and re-validates `checkedAgainst`
against a fresh `/transparency` read before it posts. An approval whose snapshot no longer
holds fails closed and returns to the queue.

> Written before Buzz was investigated. It is **not** merely "a card type, not new
> infrastructure" — see the Buzz section below, which found that the approval kinds are
> unverified at our relay pin, and that nothing in `policy.yaml` would currently stop an
> inbound Buzz message from reaching a publish tool.

**Publishing:** direct to the X API on pay-per-use. At ~$0.45/month for writes, a
scheduling SaaS layer buys nothing here — and Premium already gives post analytics in the
UI, which was the other reason to rent one.

## Buzz — investigated 2026-08-10

Read from source in `averray-reference-agent` and the upstream `block/buzz` checkout, not
from the plan prose.

### What it is

A Nostr relay in Rust, running at `buzz.averray.com`, pinned to
`ghcr.io/block/buzz:0.2.0`. Closed: `BUZZ_REQUIRE_AUTH_TOKEN=true`,
`BUZZ_ALLOW_NIP_OA_AUTH=true`, `RELAY_OWNER_PUBKEY` set. **Membership by issued credential
is the allowlist** — there is no separate allowlist to maintain.

### "Adding an agent" — what it actually buys, and what it does not

`scripts/ops/mint-buzz-agent-auth.ts` mints a fresh keypair plus a NIP-OA `auth` tag signed
by the owner secret. Run on your own machine, never the VPS — the owner secret must never
reach the box. A social agent would get **its own Nostr identity**, distinct from Hermes,
which is genuinely worth having: its messages are attributable to it, and its key can be
rotated without touching Hermes.

Three properties, verified in `services/slack-operator/src/nip-oa.ts`, that must not be
oversold:

1. **The expiry is not enforced.** The `created_at<` clause constrains a field *the agent
   itself controls*; the source is explicit that "a misbehaving agent can backdate". It
   bounds an honest agent and nothing else.
2. **There is no revocation.** The entire revocation story is "the owner may refuse to
   issue new auth tags". An issued credential cannot be withdrawn.
3. **Key hygiene is the only real control.** If the agent key leaks, the remedy is to
   rotate the agent key. That is the whole mechanism.

So minting a social agent is cheap and useful, but it is **a credential with no expiry and
no revocation**. Treat the key like the other production secrets, not like a config value.

### ✅ Pre-flight result (2026-08-10) — the primitive is half wired, and the half we need is missing

Resolved from source by fetching the `relay-v0.2.0` tag (`0d9be2f`, 2026-07-10) — the exact
commit behind `ghcr.io/block/buzz:0.2.0` running in production. **No credentials, no events
published, nothing touched.**

**The grant/deny half is real and fully wired at our pin:**

| Evidence at `relay-v0.2.0` | |
|---|---|
| `crates/buzz-core/src/kind.rs:436` | `KIND_APPROVAL_GRANT: u32 = 46030` |
| `crates/buzz-relay/src/handlers/command_executor.rs:60` | dispatched to `handle_approval_grant` |
| `crates/buzz-relay/src/handlers/ingest.rs:255` | requires `Scope::MessagesWrite` |

Better than expected: the relay is a **state machine, not a message bus**. `handle_approval_grant`
looks the approval up in its own database, and rejects unless the record is `Pending` and
unexpired. That gives replay protection and a real lifecycle for free.

> **Two expiries, opposite enforcement — do not confuse them.** The NIP-OA *auth tag*
> expiry is **not enforced** (the agent controls the field it constrains). The *approval
> record* expiry **is** enforced, server-side, by this handler. Same system, same word,
> opposite guarantees.

**But nothing creates an approval record.** `create_approval` exists only in the `buzz-db`
layer and is called from **no ingest path at all**. Upstream's own conformance test says so
in as many words — *"`create_approval` is only reached from unit tests"* — and that is true
both at `relay-v0.2.0` **and at current HEAD** (`mobile-v0.8.0-rc.3`). It is not a version
gap we can upgrade past.

So today a `KIND_APPROVAL_GRANT` event is rejected with **"approval not found"**, because
there is no record to grant. The approval flow is half a primitive: the answer exists, the
question does not.

**Note on method.** The live pre-flight originally proposed here — publish a 46030 event and
see if it is accepted — would have been *actively misleading*. It would have been rejected,
and "invalid: approval not found" reads like "this relay does not support kind 46030" when
the kind is in fact fully supported. Reading the source answered the real question; the
event would have answered a different one and looked authoritative doing it.

**Consequence for the design:** keep approval state in **our** store, and use Buzz as the
transport for the card and the operator's reply. The reply is an ordinary signed stream
message; the publish tool checks our record, not the relay's. This is the same rule the
deployment plan already applies to alert dedup — *"stays in our code, never in the relay"* —
and it means the Buzz half is unblocked today rather than waiting on upstream.

Revisit if upstream ever wires approval creation into an ingest path. Do **not** write
records into Buzz's Postgres directly to fake it: that is reaching into another product's
schema, and the next relay migration silently breaks the approval gate on a publishing path.

### The approval primitive — original assessment (superseded by the pre-flight above)

`KIND_APPROVAL_GRANT` (46030) and `KIND_APPROVAL_DENY` (46031) are real: defined in
`crates/buzz-core/src/kind.rs` upstream, with builders in `buzz-sdk`. An authorize-this-
action flow being a protocol primitive is exactly what makes Buzz the right home for the
approval gate rather than a nicer notification channel.

**But they appear nowhere in our own code** — only in `BUZZ_DEPLOYMENT_PLAN.md` prose — and
the local `block/buzz` checkout is a shallow clone at `mobile-v0.8.0-rc.3` with no
`relay-v*` tags, so **I could not verify these kinds exist in the pinned production relay
0.2.0.** The deployment plan flagged this exact risk in advance: *"features we may want
(agent kinds, approval flow) could postdate it."*

**Pre-flight before designing on it** — cheap, and it fails loudly:

```bash
# Publish a kind-46030 event to the relay as the agent and see whether ingest accepts it.
# Accepted → the primitive is available at our pin. Rejected → the pin must move first.
```

If 0.2.0 rejects it, the choice is moving the pin to a deliberate `:sha-<7>` or building
the approval as an ordinary signed stream message with our own semantics. **Do not move the
pin as a side effect of this feature** — that is a relay upgrade under a live money-path
monitor, and it deserves its own decision.

### ⚠ The finding that changes the design

Buzz inbound is **live and not read-only**. A mention in the ops channel is handed to a
**full Hermes session with its whole tool surface**. The guards in `buzz-inbound.ts`
(SELF / ECHO / RATE / mention) are documented as anti-loop and anti-spam — **explicitly not
authority**. Authority is supposed to live in `hermes/config/policy.yaml`.

`policy.yaml` today governs: `claim`, `submit`, `budget`, `dispatch`, `anomaly`. **There is
nothing in it about publishing to an external channel.**

Therefore: **if a "post to X" tool is added to Hermes's surface, nothing in the current
authority layer stops an inbound Buzz message from reaching it.** The rate limit would cap
how often, not whether. That is not a reason to avoid Buzz — it is the specific thing to
build before the publish tool exists.

The pattern to copy is already in the same file. `dispatch` is fail-closed and
proposes-only: `allowed_repos: []` means Hermes can propose nothing until an operator opts
a repo in, and every proposal still needs approval. The social publish policy must be the
same shape:

```yaml
social:
  allowed_accounts: []        # fail-closed; empty means publish nothing
  propose_only: true          # a draft is never a post
  require_approval: true      # no auto-approval path, at any confidence
  per_day_max: 2
```

A publish tool must be unreachable without an approval record, and the approval must be
checked **by the tool**, not by the channel that carried the request.

### Where Buzz helps beyond the approval card

**Best fit — the morning digest.** `services/slack-operator/src/morning-digest.ts` already
exists, already publishes to Buzz once a day and then goes silent, and already has the
discipline this needs: it quotes the same strings the board renders, and an invalid config
*disables* it with a named problem rather than guessing an hour. The sweep's output is a
natural extra section in that message.

That is better than a dedicated social channel, which would compete with the digest for the
same attention budget and give the account its own stream of noise to ignore. **One message
a day, one place.**

**Confirms the sweep's design.** The plan states *"alert dedup stays in our code, never in
the relay"*, and `decideOpsNarration` is edge-triggered, self-deduped and mute-gated —
exactly the shape of the committed-state edge-triggering in step 1. The sweep is already
consistent with the house pattern.

**Not worth doing:** a separate social channel; pushing dedup into the relay; and
**never** enabling Hermes v0.20.0's bundled Buzz gateway — it is a second Buzz→agent path
answering to a weaker allowlist, and two paths with different gates is how the strict one
becomes optional.

### Revised build order for the Buzz half

1. ~~**Pre-flight the approval kinds**~~ — **done.** Grant/deny is wired at our pin;
   approval *creation* is not wired anywhere upstream. Approval state stays in our store.
2. ~~**Digest line**~~ — **done**, see below.
3. **Add the `social:` block to `policy.yaml`** — fail-closed, proposes-only. Before any
   publish tool exists, not after. **This is the next thing.**
4. **Mint the social agent's own NIP-OA credential.** Own keypair, own identity, stored
   with production secrets. Needs `Scope::MessagesWrite`.
5. **Approval card** — Buzz carries the card and the reply; our store holds the record.
6. **Publish tool**, gated on a recorded approval it verifies itself.

### The digest line, as built

**Lives in the sibling repo**, branch `claude/social-digest-line` of
`averray-reference-agent` — the digest and the Buzz publisher are both there. Nothing about
it belongs in this repo.

- `services/slack-operator/src/social-signal.ts` — fetches `/transparency`, composes one line
- `morning-digest.ts` — new optional `socialSignal?: { text, tone } | null`, following the
  `bankRequests` precedent exactly: decided elsewhere, merely composed by the digest
- Renders as `Public record: 143 settled, no external agents in 24h`
- 13 new tests plus 5 on the digest; 202 slack-operator unit tests green; typecheck clean

**The division of labour, and why.** The digest **observes**; CI **decides**. The digest does
not re-implement the sweep. Porting the veto into TypeScript would put two implementations
of a truth boundary in two repositories, and a rule that exists to stop false claims is
precisely the rule that must not drift. The digest publishes nothing and makes no claim, so
it needs no veto — it reports a reading and how fresh it is.

What that buys today: the number that matters right now is `composition24h.external`, and
the morning it stops being 0 is the morning something happened. The line surfaces that
without any approval machinery existing yet.

Three rules it enforces, each with a test:

1. **A failed read never shows figures.** "no external agents" and "we could not ask" must
   never render the same — the first is a fact about the product, the second about our
   instruments. There is a test asserting the two strings differ.
2. **A stale field is labelled stale**, and a stale external count never earns the
   "worth a post" flag.
3. **The line never counts toward "needs you now".** A post worth writing is not an
   operational incident, and a transparency blip is not either. Wiring its tone into the
   urgency tally is how that tally stops being believed — so it is deliberately not wired,
   and a test pins that even a `red` tone leaves the closing line at "Nothing is waiting on
   you."

**Worktree note:** that worktree has no `node_modules`. Sharing the main checkout's via
symlink works for running tests, but `.gitignore` has `node_modules/` — a trailing-slash
pattern matches directories, **not symlinks** — so the link is committable and must be
removed before any `git add -A`. Prefer a real `npm install` in the worktree.

## Replies — research only

Traction on X for a technical account comes from replies, not posts. An account with no
followers posting into the void gets nothing regardless of post quality.

Premium matters here specifically: **Premium boosts reply ranking in conversation
threads.** That is the single most valuable thing the subscription provides for this
account, and it is worth more than anything on the posting side.

So: the agent may **research** reply targets — sweep for threads worth engaging, draft an
angle for each — and surface them in the same Buzz card. **Pascal sends every reply by
hand.** That is the ToS line and also the quality line; a boosted reply that reads as
automated wastes the boost.

Note the cost asymmetry from constraint 5: reply research is a *read* workload and is
therefore the expensive half of this packet. **Defer it to v2.** In v1, reply targets are
found by Pascal using X normally, which costs nothing.

## Out of scope

- Any autonomous posting, under any threshold or trust level
- Mentions monitoring, sentiment tracking, competitor tracking (all read-heavy, all low
  value at this stage)
- Following, unfollowing, DMs, likes, automated replies
- Any metric not already public in `/transparency`
- Platform or founder revenue, in any framing (constraint 4)
- Verified Organizations (gold check) — a separate, more expensive subscription than the
  Premium currently on the account. Not needed; note it only so nobody assumes the current
  sub provides it.
- Cross-posting to LinkedIn/Mastodon/Bluesky. Same pipeline could feed them later; adding
  it now triples the surface before the first post is proven.

## Build order

1. ~~**Signal reader + veto**~~ — **done.** Reads `/transparency`, evaluates signals 1 and
   2, applies the veto, emits evidence. No drafting, no posting. Now run it for a week and
   read the output before building anything else.
2. **Drafting** — variants, voice, link-free preference.
3. **Buzz approval card** — approve/edit/kill, recorded approval.
4. **Publishing tool** — re-validate, post, record the post id back onto the draft.
5. Signals 3–6.
6. v2: reply research.

Step 1 alone answers the question that decides whether the rest is worth building: **over
a week, does this thing fire on anything worth posting?** If it fires twice and both are
real, build the rest. If it fires eleven times and nine are filler, the thresholds are
wrong and no amount of drafting quality fixes that.

## First production reading

Run against `https://api.averray.com/transparency` on 2026-08-10:

| Field | Value | Status |
|---|---|---|
| `flow.jobsSettled.allTime` | 142 | fresh |
| `flow.composition24h.external` | 0 | fresh |
| `chain.head` | 19,290,804 | fresh |

Behaviour observed: the cold run seeded `jobs-settled-100` and announced nothing; the
second run went quiet; a warm run with state rolled back to 50 correctly announced *"Averray
mainnet has passed 100 settled jobs"*. The external-agents signal did not fire, because the
public payload says 0 — the veto path is the one carrying real production weight today.

State is committed calibrated to this reading, so **the next thing this account announces
on its own is 500 settled jobs** — or the first external agent, whichever lands first.

## Open questions for Pascal

1. Daily sweep, or twice weekly? Daily costs nothing and catches signal 1 fast; twice
   weekly reduces the temptation to treat the queue as a content calendar.
2. Does the `social:` PR label exist, or does Codex create it?
3. Buzz card, or start with the GitHub step summary as the approval surface? The step
   summary is free and already carries the fired claims; Buzz is nicer but is real work in
   a repo you'd have to touch separately.
4. Are the milestone steps right? `10/50/100/500/1000/5000/10000` means the next automatic
   announcement is a long way off at 142 settled. Tighter steps mean more to say and more
   chance of saying something trivial.

---

**Sources for the API and Premium figures above** (verified 2026-08-10; this pricing has
changed twice in 2026 — re-check before building step 4):

- [X API pay-per-use pricing](https://www.socialmediatoday.com/news/x-formerly-twitter-announces-new-api-pricing-structure-xai/811667/)
- [X API pricing tiers 2026](https://api.sorsa.io/blog/twitter-api-pricing-2026)
- [About X Premium](https://help.x.com/en/using-x/x-premium)
- [X Premium reach analysis (Buffer, 18M+ posts)](https://buffer.com/resources/x-premium-review/)
