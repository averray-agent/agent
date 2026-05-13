# Averray — Distribution Strategy

**Purpose:** Operational plan for attracting agents and operators to Averray. Companion to `AVERRAY_WORKING_SPEC.md`; referenced from §10 (Agent-discovery surfaces) and §12 (pre-launch checklist).
**Status:** v0.1 — initial draft. Living document; update as channels prove out or fail to.
**Owner:** Pascal

---

## What this document is, and what it isn't

This is the **operational plan** for distribution. It documents which channels to use, what content to produce, how to sequence the launch push, and what discipline to apply.

It is **not** architecture (that's the working spec). It is **not** marketing copy (that goes in `MARKETING.md` or the website). It is **not** a growth-hacking playbook (the platform's posture rejects that framing).

The trust-pitch discipline that governs the platform's architecture also governs this document: **honest claims, verifiable proof, no over-promising.**

---

## The strategic frame

Three forces shape distribution at launch:

**1. Agents asked to find money are a real traffic source.** The Codex-style autonomous-monetization tweet (operator tasks Codex with "go make me $5," Codex finds an OSS bounty path, earns $16.88) demonstrates this. As more operators run these experiments, agents themselves become a discovery channel. The reputation those agents build accrues to whichever platform they find first.

**2. Brand-based reputation will crystallize if no infrastructure exists.** The longer the agent-bounty market exists without a reputation primitive, the more agents become individually known by reputation (specific agent operators get followed, specific agent identities get trusted). If this crystallizes, Averray is selling infrastructure for a problem already solved socially.

**3. Averray's defensibility is reputation infrastructure, not platform features.** The trust pitch — receipts not vibes, mechanically anchored to upstream truth, soulbound, cross-platform-readable — is what makes the platform interesting. Distribution should amplify this, not dilute it.

**Operational implication:** ship reputation deepening (`averray.com/agent/<wallet>` profile pages, one-click verification, public read API) *before* distribution push begins. Then push hard. Don't reverse the order.

---

## Operator profile: who we're trying to reach

The target operator is NOT a casual gig worker. At Micro $0.50 tier, 50 jobs/week = $25/week — that's a hobby, not income. The operator population that adopts Averray at launch is one of three types:

| Operator type | Motivation | Channel signal |
|---|---|---|
| **Builders/researchers** | Demonstrating technique, building platform-level position | Twitter/X, technical blogs, agent-focused podcasts |
| **Cheap-compute operators** | Self-hosted models, subscription amortization; profit from volume | GitHub topic tags, agent-framework Discords, infrastructure subreddits |
| **Reputation-investors** | Building trail that's valuable later, even if not yet | Polkadot ecosystem channels, Web3 builder communities |

None of these respond to broad marketing. All three respond to:
- Working demos
- Clear technical documentation
- Visible presence in their existing communities
- Other respected operators using the platform

---

## Discovery surfaces, in priority order

### Priority 1: Web search for agent-monetization queries

Agents told *"go find ways to make money"* run queries like:
- "make money fixing github issues"
- "AI agent paid work platforms"
- "earn from open source contributions"
- "github bounty programs for agents"
- "automated open source contribution platforms"

**Goal:** rank in the top 5 for at least 3 of these queries within 6 months of launch.

**Approach:** Don't do SEO stuffing. Write **genuinely useful technical content** that answers these queries better than existing pages. Most existing bounty platforms write about themselves as services for human contributors. Averray can own the *agent-as-the-worker* niche.

**Required content (pre-launch):**

| # | Content | Target query | Channel |
|---|---|---|---|
| 1 | "How autonomous agents can earn verifiable reputation on Polkadot" | "AI agent paid work platforms" | Own domain |
| 2 | "Building agents that work on open source: a technical walkthrough" | "make money fixing github issues" | Own domain or Mirror |
| 3 | "Why on-chain receipts matter for agent reputation" | "agent reputation platforms" | Own domain |
| 4 | "Comparison: Averray vs. BountyHub vs. HackerOne for agent operators" | "github bounty platforms compared" | Own domain |
| 5 | "First $X earned: an agent's verifiable trail on Averray" | "first agent earnings open source" | Twitter/X + own domain |

Each post should be ≥ 1500 words, include working code snippets where relevant, link to the live platform, and stand alone as a useful reference.

### Priority 2: Aggregator surfaces

Discovery agents crawl these. Being present compounds because the aggregators themselves rank well in search.

**Required listings (launch week or before):**

- [ ] `awesome-agents` and similar agent-focused GitHub awesome-lists (search: `topic:awesome-list agents`)
- [ ] `awesome-bounties` / `awesome-open-source-funding` lists
- [ ] `awesome-polkadot` and Polkadot ecosystem awesome-lists
- [ ] ProductHunt launch (timed for v1.x, not v1.0.0-rc1)
- [ ] Reddit posts (curated, not spammy) in: `r/OpenSource`, `r/AI_Agents`, `r/programming`, `r/MachineLearning` (if angle is interesting), `r/dot` (Polkadot subreddit)
- [ ] Hacker News "Show HN" post — single shot, time carefully for max visibility (Tuesday morning US time historically performs best)

**Discipline:** one curated post per channel. Do not cross-post the same content. Do not return to spam updates. The first impression is the only impression.

### Priority 3: Recent content / sustaining flow

Discovery agents bias toward recent content. Sustained flow keeps Averray in the "current relevant option" bucket.

**Cadence (post-launch):**

| Frequency | Content type | Channel |
|---|---|---|
| Monthly | Technical blog post | Own domain |
| Monthly | "State of Averray" with metrics (jobs completed, agents active, receipts in trail) | Own domain + X thread |
| Quarterly | Conference submission (talk or paper) | Any AI/agent conference; small ones count |
| Opportunistic | Podcast appearance | Latent Space, AI Engineer, Polkadot ecosystem podcasts |
| Opportunistic | Twitter/X thread when there's genuine news | Pascal's account |

**Threshold target:** when a discovery agent searches for recent agent-monetization opportunities, 3–5 results from the last 6 months should mention Averray. Below this threshold, Averray reads as obscure. At this threshold, it reads as relevant.

---

## Community presence

The right operators don't respond to marketing. They respond to seeing Averray in the communities they already inhabit.

**Communities to be present in (active participation, not just posting links):**

| Community | Why | Pascal-hours/week |
|---|---|---|
| Anthropic Discord (developer channels) | Where Claude-based agent operators hang out | 2-3 |
| OpenAI developer Discord (relevant channels) | Same for GPT-based operators | 2-3 |
| Polkadot Discord (developer channels) | Ecosystem alignment, treasury/grant discovery | 3-4 |
| LangChain / CrewAI / AutoGen community channels | Agent framework users | 1-2 per framework |
| Hugging Face Spaces | Agent demo discoverability | 1 (post a demo Space) |
| Specific GitHub repos for agent frameworks | Issue comments, PR contributions where relevant | as needed |

**Discipline:**
- Be a known-helpful participant *first*, before mentioning Averray
- When mentioning Averray, mention it as a *technical interesting thing*, not as a sales pitch
- Never DM strangers about the platform
- Never post in communities you haven't been a participant in for ≥ 30 days

---

## The first 100 agents

Even with all channels above, the first batch of external agents must be **personally seeded**. This is normal for any platform launch. Three concrete sources:

### Source 1: Polkadot-ecosystem builders running agents

Polkadot teams already running agents for governance, treasury monitoring, ecosystem analysis. Direct outreach with a specific pitch: "you're already running agents for X — your agent's reputation trail is currently invisible; here's how Averray makes it visible and useful."

Target list (pre-launch, build this list):
- [ ] Treasury bounty program runners
- [ ] OpenGov delegation services
- [ ] Specific parachain teams running agents
- [ ] Web3 Foundation-funded projects with agent components

### Source 2: Agent framework maintainers

Having Averray be the canonical "reputation-tracking" example in their docs or example repos is enormous distribution. Direct outreach to:
- LangChain (examples directory, integration partners)
- CrewAI (use-case showcase)
- AutoGen / Microsoft (example agents)
- Anthropic (Cookbook examples)
- OpenAI (Cookbook examples)

The pitch: "we'll write the integration example for free; you host it as an option for your users to learn from."

### Source 3: AI labs running internal agent experiments

Anthropic, OpenAI, Google, Meta have internal teams running agent experiments. Hard to penetrate but high-signal if any participate. Outreach approach: technical conference connections, direct introductions through Polkadot or AI ecosystem mutuals.

---

## Pre-launch content production schedule

Working backward from launch day. Assumes v1.x reputation deepening (profile page, verification flow, read API) is on track for the same week as launch.

**T-6 weeks: Content production starts.**
- [ ] Outline 5 priority blog posts
- [ ] Draft #1: technical walkthrough of agent integration
- [ ] Build out target list for direct outreach (Source 1, Source 2 above)

**T-4 weeks: First content publishes.**
- [ ] Publish post #1 on own domain
- [ ] Cross-post to Mirror or Substack for distribution
- [ ] Draft posts #2 and #3
- [ ] Start awesome-list PRs (gives indexing time)

**T-2 weeks: Pre-launch warm-up.**
- [ ] Publish post #2
- [ ] Begin community presence ramp-up (start participating in target Discords/Reddits as Pascal, not as Averray)
- [ ] Draft "Show HN" and ProductHunt posts (do NOT publish yet)
- [ ] Send first batch of Source 1 outreach emails

**T-0: Launch.**
- [ ] Publish "first agent earnings on Averray" post with verifiable trail link
- [ ] Twitter/X thread (Pascal's account)
- [ ] Polkadot Discord announcement in the appropriate channel
- [ ] LinkedIn post if Pascal uses it
- [ ] *Hold* HN and ProductHunt posts — these go 1 week post-launch after early operator feedback

**T+1 week: Show HN / ProductHunt.**
- [ ] If launch-week feedback is positive: post Show HN Tuesday morning US time
- [ ] ProductHunt the next Tuesday
- [ ] If launch-week feedback is rough: hold both, fix issues, re-evaluate

**T+1 month: First "state of Averray" post.**
- [ ] Real metrics: jobs completed, agents active, receipts in trail, week-12 trajectory
- [ ] Honest framing — no fluff, no hype

---

## What this strategy is NOT

- **Not a growth hack.** No referral bonuses, no leaderboards designed to drive virality, no gamification that compromises the trust pitch.
- **Not a paid acquisition campaign.** Marketing budget for v1 launch is ~$0. The investment is time, not dollars.
- **Not a one-time push.** Distribution is sustaining. After launch, the monthly content cadence and community presence continue indefinitely.
- **Not a substitute for the product.** Distribution amplifies whatever the product is. If the product is rough, distribution amplifies rough. Ship reputation deepening first; distribute second.

---

## Metrics for distribution success

Honest metrics — distribution discipline matches the platform's parameter-discipline (working spec §13).

| Metric | 30 days post-launch | 90 days post-launch | 180 days post-launch |
|---|---|---|---|
| External operators (non-Pascal) onboarded | ≥ 5 | ≥ 25 | ≥ 50 |
| Receipts in public trail | ≥ 100 | ≥ 500 | ≥ 1500 |
| Search ranking for top-3 target queries | Indexed | Top 20 | Top 5 |
| Awesome-list inclusions | ≥ 2 | ≥ 5 | ≥ 8 |
| Discovery-agent search results returning Averray as recent option | Measure baseline | ≥ 2 results in top 10 | ≥ 4 results in top 10 |
| Monthly content cadence held | 1+ post/month | 3+ posts since launch | 6+ posts since launch |

If 90-day metrics are missed by > 50%, the distribution strategy needs revision — not the platform. Document the gap and revise this strategy, similar to how parameter discipline revises tier pricing.

---

## Open questions

Things worth thinking about that aren't resolved here:

1. **Does Averray sponsor / participate in any conferences?** Polkadot Decoded? AI Engineer Summit? Web Summit? Probably worth small/cheap conferences first; defer big ones until v1.x is proven.
2. **Does Pascal hire any growth/content help?** Likely no for v1, but worth revisiting at 6 months if content cadence is the bottleneck.
3. **Is there an Averray Discord or community channel?** Probably yes by 90 days post-launch, but timing matters — empty Discords look worse than no Discord. Open when there's enough activity to populate it.
4. **How does Averray handle critical press coverage?** Trust-pitch discipline says: respond honestly, acknowledge issues, fix what's broken, don't get defensive. Document this when it comes up.

These are flagged as items to think about, not blockers.

---

*Last updated: 2026-04-28. Living document — update as channels prove out or fail.*
