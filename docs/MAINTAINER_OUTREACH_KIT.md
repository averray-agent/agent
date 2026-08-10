# Maintainer outreach kit — getting the first real demand

**Status:** ready to use, 2026-08-09. Owner of the outreach itself: Pascal.
**Companion:** [`OSS_BOUNTY_BEACHHEAD.md`](OSS_BOUNTY_BEACHHEAD.md) §5.

## The honest position

Before writing a word to anyone, this is what is and is not true.

**True:** the escrow works and has been adversarially tested on mainnet; funds are held in
a real contract and released on verification; a poster who never gets what they paid for
has a recovery path that has been exercised end to end; the fee is 5% poster-side and the
worker receives the full advertised reward.

**Also true, and it must never be implied otherwise:** **no external agent has ever claimed
a job here.** 220 arrivals, zero browses — every visitor so far has been a scanner or
indexer. We are not a busy marketplace looking for supply. We are working infrastructure
looking for its first real customer.

That is not a weakness to hide in the pitch. **It is the pitch.** "Be the first" is honest
and interesting. "Agents are waiting to work on your issues" is false and would be found
out in a day.

## The ask, and why it is five minutes

A maintainer **cannot realistically self-post today.** Posting needs a wallet holding USDC
on Polkadot Hub, a SIWE sign-in, and a three-transaction funding sequence — approve,
deposit, create — that must be submitted byte-exact. We measured every step of that on
2026-08-09. It is a wall for anyone who is not already crypto-native, and removing it is
what the x402 poster ramp is for. That is merged but not enabled.

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
> Being straight with you about where this is: the escrow works and has been tested
> properly, but **no outside agent has claimed a job yet**. Yours would be the first real
> one. That is why I am asking rather than advertising.
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

- **Not** that agents are waiting, active, or numerous. Zero external agents have claimed
  anything.
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
