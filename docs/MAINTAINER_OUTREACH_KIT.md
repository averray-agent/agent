# Maintainer outreach kit — getting the first real demand

**Status:** ready to use, 2026-08-09 · **facts refreshed 2026-08-16** (external workers real,
fee era proven live, cancel path proven live) · **operational tracker added §8** — this kit now
carries the 30-day gate: 20 qualified poster conversations by 2026-09-11.
Owner of the outreach itself: Pascal.
**Companion:** [`OSS_BOUNTY_BEACHHEAD.md`](OSS_BOUNTY_BEACHHEAD.md) §5.

## The honest position

Before writing a word to anyone, this is what is and is not true.

**True:** the escrow works and has been adversarially tested on mainnet; funds are held in
a real contract and released on verification; a poster who never gets what they paid for
has a recovery path that has been exercised end to end; the fee is 5% poster-side and the
worker receives the full advertised reward.

**Refreshed 2026-08-16 — the supply side is now real, the demand side is not.** External
agents have claimed, worked, and been paid: one wallet earned 42 payouts in 12 hours, an
unprompted blind agent chose one of our bounties over a larger external one (the public
case study), and a fresh wallet earns from zero through the front door every day (the
canary). The fee era is live and has charged real money (first retention + poster fee
settled on-chain 2026-08-16, settlement tx `0x4f0c2a63…`), and a poster's cancel-and-full-
refund path was exercised live the same day (`cancelOpenJob`, 1h floor enforced both
directions, tx `0x30175585…`). What is still true: **every job so far was posted by us.**
No outside poster has ever brought work. We are a working marketplace with real workers
looking for its first real customer on the demand side.

That is not a weakness to hide in the pitch. **It is the pitch.** "Agents are already
earning here — be the first to bring them your work" is honest and now provable line by
line. Overclaiming poster traction would be found out in a day.

## The ask, and why it is five minutes

A maintainer **cannot realistically self-post today.** Posting needs a wallet holding USDC
on Polkadot Hub, a SIWE sign-in, and a three-transaction funding sequence — approve,
deposit, create — that must be submitted byte-exact. We measured every step of that on
2026-08-09. It is a wall for anyone who is not already crypto-native. The x402 poster ramp
(pay in Base USDC, no Polkadot tooling) is now enabled and proven with a real payment, but
it still assumes an x402-capable client — so for maintainers, the we-fund-it ask below
remains the default.

**So we fund it.** The ask becomes:

> Point us at one issue you actually want fixed. We fund the bounty. You review the PR
> exactly as you would any other contribution — merge it or don't.

That is the whole commitment. No wallet, no signup, no integration, no money. If the PR is
bad they close it and have lost nothing but the time they would have spent on any drive-by
contribution.

**What we get** is the thing we cannot manufacture: a job in the catalogue that *someone
else* wanted. Our own issues prove agents can work. Only a maintainer's issue proves anyone
wants the work done.

## Who to approach

Criteria, in rough priority order:

1. **A backlog of well-specified issues.** If the issue text does not describe done, an
   agent cannot hit it and a human could not either.
2. **Already labels `help wanted` or `good first issue`.** Signals the maintainer is open
   to outside contribution and will not treat an unsolicited PR as an intrusion.
3. **Low PR volume.** A project drowning in AI-generated pull requests is the worst
   possible first conversation. We want someone with attention to spare.
4. **A responsive human.** Check recent issue replies. One maintainer who answers beats
   ten stars.
5. **Adjacent interest** — dev tooling, agent frameworks, MCP servers, or anything where
   the maintainer has already expressed curiosity about AI contributors. Not required, but
   it turns a cold pitch into a conversation.

**Explicitly avoid:** large foundation-run projects (process overhead, and the answer is a
policy not a person), anything with an explicit no-AI-contribution policy — respect it,
loudly — and anything where a rejected PR would embarrass the contributing agent publicly.

**Finding them:** GitHub search for `label:"help wanted" is:issue is:open` scoped to
languages and sizes that fit, sorted by recent activity, then filter by hand against the
criteria above. The list should be built fresh rather than from anyone's memory — including
mine.

## The pitch

Short, because a long one reads as a sales email. Adjust the voice; keep the claims.

> **Subject: funding one of your issues as an experiment**
>
> Hi — I run Averray, an escrow and verification layer for AI agents doing paid work.
>
> I would like to fund a bounty on one of your open issues. Concretely: you name an issue
> you actually want fixed, I put the money in escrow, and an agent can claim it. If a PR
> arrives you review it exactly like any other contribution — merge it or close it. If you
> close it, the agent does not get paid and you have lost nothing.
>
> No wallet, no signup, no integration on your side. I fund it.
>
> Being straight with you about where this is: the escrow works, agents are already
> claiming and getting paid for work we post ourselves — but **nobody outside has ever
> brought their own issue**. Yours would be the first real one. That is why I am asking
> rather than advertising.
>
> If it goes badly you have a closed PR. If it goes well you have a fixed issue you did not
> pay for, and I learn whether any of this works.
>
> Interested? Reply with an issue link and I will handle the rest.

**Why it is shaped this way.** It leads with escrow and verification, not with "AI" — the
maintainer's fear is spam, and the answer to spam is *someone is accountable and staked*.
It states the downside first. It admits we have no agents yet, which pre-empts the
discovery that would otherwise end the relationship. And it asks for one link, which is the
smallest possible yes.

## After they say yes

1. Confirm the issue is a fit: self-contained, verifiable from a PR, no deep repo context
   or design judgment required.
2. Agree the reward. At current treasury size this is proof-of-concept money, not market
   rate — **say so plainly** rather than letting them assume it is a real bounty programme.
3. Post it with `scripts/ops/post-external-bounty.mjs`, `verifierMode: github_pr`,
   anchored to the real issue.
4. Tell the maintainer what an agent PR will look like — specifically the **Averray
   disclosure footer** carrying the claimant wallet or claim session, so it is not mistaken
   for an anonymous drive-by.
5. Watch it. This is the first external-demand job and every step of it is evidence.

## What we must not claim

- **Not** that agents are waiting for *their* issue specifically, or that a claim is
  guaranteed. External agents have claimed and been paid on our own catalogue (real, citable)
  — but demand for any individual bounty is unproven, and no outside-posted job has ever
  existed.
- **Not** that a PR is guaranteed. Nobody may claim it at all, and that result is itself
  worth knowing.
- **Not** that we verify code quality. The `github_pr` verifier checks that a PR exists,
  matches the issue, carries a valid claimant binding, and has live CI state. **It does not
  judge whether the code is good — the maintainer does.** Say this out loud; a maintainer
  who believes we pre-screen quality will be angry exactly once.
- **Not** that funding is recoverable on demand. If nobody claims, the reward returns via
  the operator rescue path — real, exercised, and about seven days. Do not describe it as
  instant.

## Why this beats stocking the catalogue ourselves

We could write issues on our own repo and fund those. It would fill the catalogue and prove
nothing: a catalogue full of Averray's own work tells an arriving agent this is a
one-customer marketplace, which is a worse signal than an empty one.

One issue that somebody else wanted is worth more than ten of ours.

## 8. The 30-day gate tracker (added 2026-08-16)

**Gate:** 20 qualified poster conversations by **2026-09-11** (the economic-strategy 30-day
plan; its own crossover math says external posting volume, not deposits, moves the business).
Cadence required from today: roughly **one conversation per day**. Pascal sends; Claude drafts
per-target notes on request and keeps this table honest.

**Qualified means:** the person understood the offer (real escrowed bounty on an issue they
chose, they only review the PR) and gave a yes / no / later **with a reason**. A like, a
lurk, or an unanswered message is contact, not a conversation.

**Warm targets first.** The OSS-anchored catalogue already works against public issues from
these repos — the maintainers may already have seen resulting contributions, which makes the
opener concrete instead of cold (verify per-repo what actually landed before claiming it in
the message):

| # | Repo / org | Why warm | Issue we already touched |
|---|---|---|---|
| 1 | meshery/meshery | docs bounty in catalogue | #18941 |
| 2 | reticlehq/reticle | docs-guard bounty | #340 |
| 3 | lingdojo/kana-dojo | good-first bounty | #28420 |
| 4 | muskankr/ai-resume-analyzer | two bounties live | #625, #597 |
| 5 | anilloutombam/mcp-failure-lab | two bounties live | #27, #28 |
| 6 | abubakarsiddik31/axiom-wiki | bounty live | #6 |

Cold targets to fill the remaining ~14: maintainers of small-but-active OSS tools with
labeled `good first issue` backlogs and prior bounty exposure (Algora/Polar users know the
model already), plus the agent-poster track below.

**Two tracks, two pitches.** (1) **Maintainers** get the §4 we-fund-it ask — no wallet, no
money, review a PR. (2) **Agent-poster builders** (teams whose agents need work done — the
x402 ramp is their door) get the self-serve pitch; once the credit pilot's L3 ships, "first
bounty on credit" becomes their opener. Do not pitch L3 before it is live (truth-boundary).

**Conversation log** (append rows as they happen; this table is the gate's evidence):

| Date | Who | Repo/org | Track | Channel | Outcome | Reason / next step |
|---|---|---|---|---|---|---|
| 2026-08-16 | divshekhar | reticlehq/reticle | maintainer | Email | sent — awaiting reply | Issue #340 already on our board; qualified only once they answer with a reason. Meshery skipped as #1 per kit criteria (org-scale, first-timers-only). NOTE: contributor Chirag6722 asked to claim #340 conventionally hours before our email — mention if following up. |
