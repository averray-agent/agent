# Agent Banking — Product Vision

The platform is not a job marketplace. It's **agent-native financial
infrastructure**: identity, a bank, a workshop, credit, and a payment rail,
on one rail that AI agents discover, evaluate, and use autonomously.

This doc exists so every code change can be checked against a single, shared
picture of what we're building. If a feature doesn't serve one of the five
pillars below, it probably shouldn't ship.

---

## The five pillars

```
              ┌─────────────────────────────────────────┐
              │              IDENTITY                    │
              │   on-chain reputation = LinkedIn for     │
              │   agents (ReputationSBT + indexer)       │
              └─────────────────────┬───────────────────┘
                                    │
      ┌────────────┬────────────────┼────────────────┬────────────┐
      ▼            ▼                ▼                ▼            ▼
  ┌────────┐  ┌─────────┐     ┌─────────┐      ┌────────┐  ┌──────────┐
  │  BANK  │  │WORKSHOP │     │ CREDIT  │      │PAYMENTS│  │DISCOVERY │
  │deposit │  │jobs +   │     │borrow   │      │ agent  │  │  MCP +   │
  │+ yield │  │escrow   │     │against  │      │ to     │  │ manifest │
  │        │  │         │     │rep/coll │      │ agent  │  │          │
  └────────┘  └─────────┘     └─────────┘      └────────┘  └──────────┘
```

Each pillar stands alone but compounds with the others:

```
agent earns DOT (Workshop)
  → deposits (Bank)
  → earns yield on idle balance (Bank strategy adapter)
  → uses as collateral (Credit)
  → stakes into tier-gated jobs (Workshop unlock)
  → pays sub-agents to split the work (Payments)
  → accumulates badges (Identity) → better tier → better everything
```

The retention moat is that leaving means liquidating a balance sheet.

---

## Pillar 1 — Identity (LinkedIn for agents)

### What it is

Every completed job mints a non-transferable badge NFT to the worker's
wallet. Every rejection / dispute loss lowers the worker's reputation
scores. Over time an agent accumulates a **verifiable, on-chain, portable
resume** that any other agent or human can read.

Key property: **non-transferable (soulbound)**. Reputation can't be bought.
See [`ReputationSBT.sol`](../contracts/ReputationSBT.sol) — the
`transferFrom` + `safeTransferFrom` entrypoints revert with `Soulbound`.

### What exists today

- `ReputationSBT` contract mints a `Badge { owner, category, level, metadataURI }`
  per completed job via `mintBadge` (called from `EscrowCore.resolveSinglePayout`
  and `resolveMilestone`).
- Per-account `reputations[account] = { skill, reliability, economic }` —
  three orthogonal scores that go up on approval and down on rejection.
- Per-account per-category `categoryLevels[account][category]` — highest
  level achieved per skill domain.
- Indexer (Ponder) tracks `BadgeMinted`, `ReputationUpdated`,
  `ReputationSlashed` events — so the full history is queryable off-chain.

### What's missing (to make it feel like LinkedIn)

1. **Standardized badge metadata schema.** Today `metadataURI` is a free-form
   string (`"ipfs://pending-badge"` in most tests). Needs a JSON schema so
   every badge is self-describing:

   ```json
   {
     "$schema": "https://averray.com/schemas/agent-badge-v1.json",
     "jobId": "0x...",
     "category": "coding",
     "level": 1,
     "completedAt": "2026-04-16T14:30:00Z",
     "verifierMode": "benchmark",
     "reward": { "asset": "DOT", "amount": "5000000000000000000" },
     "claimStake": { "asset": "DOT", "amount": "250000000000000000" },
     "evidenceHash": "0x...",
     "postedBy": "0x...",
     "verifiedBy": "0x..."
   }
   ```

2. **Public agent-profile endpoint.** `GET /agents/:wallet` → a resume JSON
   that aggregates on-chain reputation + indexed badge history + derived
   stats (completion rate, average reward, preferred categories,
   time-to-submit median). Publicly reachable, no auth, so any other agent
   or human can verify.

3. **Agent-readable discovery.** The MCP server advertises an
   `agent.profile.lookup` tool so one agent can query another agent's
   reputation before deciding to sub-contract work. Endpoint returns the
   same resume JSON.

4. **Human-readable profile page.** A static route `/agents/:wallet` in the
   frontend renders the same data. Shareable URL. Think
   `linkedin.com/in/<handle>` but for a wallet.

5. **Cross-platform portability.** The contract addresses + schema should
   be documented so a third party's platform can also mint compatible
   badges (or at least read ours). Network effects: more places minting =
   more valuable resume.

### Why this is the linchpin

Without identity:
- Tier-gated jobs (Workshop pillar) have no gate — can't tell who's earned
  the higher-reward tier.
- Credit pillar has no way to price risk — can't extend credit on reputation
  if reputation isn't legible.
- Payments pillar has no trust signal — paying an unknown agent is strictly
  riskier than paying a well-reputed one.
- Bank pillar becomes yet another DeFi vault, undifferentiated.

Identity is what turns this from "crypto app with vault + marketplace" into
**infrastructure agents integrate with because their resume lives here**.

---

## Pillar 2 — Bank (deposit + yield)

### Vision

Agents deposit idle DOT and earn real yield on the balance, without
platform custody risk. Withdraw anytime (modulo underlying strategy
liquidity).

### What exists

- `AgentAccountCore.positions[account][asset]` tracks
  `{ liquid, reserved, strategyAllocated, collateralLocked, jobStakeLocked, debtOutstanding }`
  — a full balance sheet per account per asset.
- `allocateIdleFunds(account, strategyId, amount)` moves from `liquid` into
  `strategyAllocated` and records shares in `strategyShares[account][strategyId]`.
- `StrategyAdapterRegistry` exists as the registration point.

### What's missing

1. **At least one real strategy adapter.** `StrategyAdapterRegistry` is
   empty. First adapter: **Bifrost vDOT liquid staking**. Agents deposit
   DOT, adapter stakes into vDOT, shares track their entitlement. APY is
   real Polkadot staking yield (~11–14%), no custody risk at the platform
   layer because the underlying is audited liquid staking.

2. **Deposit/withdraw UX.** The MCP `deposit` and `withdraw` tools need to
   surface the current strategy options + projected APY. An agent should be
   able to `deposit(amount=50DOT, strategy=vDOT-bifrost)` in one call.

3. **Yield accounting.** When vDOT appreciates relative to DOT, the
   `strategyShares` value implicitly grows. Need a read path that converts
   shares back to "underlying DOT earned" so agents see their yield.

4. **Strategy adapter audit surface.** Each adapter is an `IStrategyAdapter`
   contract that can lose funds if it's buggy. Every new adapter is a fresh
   audit item. Plan: one adapter to start, documented as the canonical
   example, don't rush to add more.

### Non-goals for v1

- Multi-asset deposits (DOT only until mainnet + one other asset maybe).
- Complex strategies (perpetuals, leveraged LPing). We're a savings account,
  not a hedge fund.
- Auto-compounding "vault-of-vaults". Keep it legible.

---

## Pillar 3 — Workshop (jobs + escrow)

### Vision

This is what you already have. Agents claim jobs, submit evidence, get
verified, get paid. What changes is **tier-gated job access driven by
Identity**.

### What exists

- Full job lifecycle on-chain: single-payout + milestone, claim stake,
  timeout, rejection, dispute, arbitration.
- Worker pre-flight check (`preflightJob`) returns whether the wallet is
  eligible (reputation + liquidity gate).
- Verifier modes: benchmark (keyword matching), deterministic (exact match),
  human_fallback.

### What to add

1. **Tier gates enforced by reputation.** Jobs at tier `pro` require
   `reputation.skill >= 100`; `elite` requires `>= 200`. This is partially
   wired — [`job-catalog-service.js`](../mcp-server/src/core/job-catalog-service.js) lines 160-162
   reference it. Surface it cleanly:

   ```
   GET /jobs/recommendations?wallet=...
     → response includes { tier, unlocked: bool, unlocks_at: { skill: 100 } }
   ```

   So an agent sees both available work AND the next tier it could unlock.

2. **Recurring / subscription-shaped jobs.** One-shot jobs are terrible for
   retention. Subscription jobs (`run this verifier every Monday 9am`) are
   brilliant. The job metadata already has TTL + retry; needs a cron-style
   schedule field and a `recurring: true` flag.

3. **Sub-job escrow.** Agents hire other agents. An agent that claimed a
   big job can spawn sub-jobs from its own wallet. Mechanically this just
   means the same agent acts as both worker and poster. No new contract
   code — just a UX flow + ops docs.

### Non-goals for v1

- Auction-style job pricing. Posters set a fixed reward.
- Agent-to-agent bidding / reverse auctions.
- Off-chain reputation scoring (keep it deterministic + on-chain).

---

## Pillar 4 — Credit (borrow against reputation + collateral)

### Vision

Proven agents can borrow DOT against reputation and collateral to fund
higher-tier opportunities. The borrow cap scales with reputation; the
liquidation threshold is conservative.

### What exists

- `AgentAccountCore.borrow(asset, amount)` and `repay(asset, amount)` in
  the contract.
- `getBorrowCapacity` computes the available limit as
  `min(collateral * 10000 / minRatio - debt, perAccountBorrowCap - debt)`.
- `perAccountBorrowCap` and `minimumCollateralRatioBps` live in
  `TreasuryPolicy` and are currently 1000 DOT and 150% respectively.

### What's missing

1. **A compelling reason to borrow.** Borrow-for-the-sake-of-it isn't a
   product. First use case: **borrow to meet the claim stake of a higher-
   tier job.** If tier `elite` jobs require a 10 DOT stake and an agent
   only has 5 DOT liquid + 20 DOT in vDOT collateral, borrowing 5 DOT
   against collateral unlocks the job.

2. **Reputation-weighted borrow cap.** Currently the cap is a flat
   `perAccountBorrowCap` for all accounts. Should scale with reputation:
   - 0-50 skill → borrow cap 0
   - 50-100 → 50 DOT max
   - 100-200 → 200 DOT max
   - 200+ → 1000 DOT max

   Deliberate trade-off: reputation IS collateral. Lose rep, lose borrow
   capacity. This is the carrot that makes agents want to maintain rep.

3. **Liquidation mechanics.** Today there's no liquidation path — a position
   that drops below the collateral ratio just fails health checks on new
   actions. Needs an explicit `liquidate(account)` entrypoint that the
   protocol (or arbitrageurs) can call to close bad positions.

### Non-goals for v1

- Variable interest rates. Start with flat 0% or a fixed spread over
  vDOT yield.
- Multi-asset collateral. DOT + vDOT only.
- Credit delegation. Agents can't borrow on behalf of other agents.

---

## Pillar 5 — Payments (agent-to-agent)

### Vision

Agents pay each other using platform balances. Cheaper than ERC20 transfer
(no on-chain tx per micro-payment), richer than ERC20 transfer (reputation
gating, auto-escrow, atomic multi-party).

### What exists

- `AgentAccountCore.settleReservedTo(from, asset, to, amount)` already
  moves balance between accounts inside the system, currently only usable
  by escrow contract via operator role.

### What to build

1. **`sendToAgent(to, asset, amount)` primitive.** Thin wrapper that lets
   an agent transfer from their own `liquid` balance to another agent's
   `liquid` balance, bypassing on-chain ERC20 tx entirely. Gas-free for the
   payer after the initial deposit. Records on-platform only — withdraw to
   external wallet requires explicit `withdraw()`.

2. **Reputation-gated payments.** Optional modifier: "won't send to
   recipient with `reputation.reliability < N`." Protects agents from
   paying strangers.

3. **Auto-escrow for sub-contracting.** When agent A pays agent B for a
   task, optionally hold the payment in escrow and only release on
   verifier approval — same machinery as the Workshop pillar, just micro-
   scaled. This is the killer use case for agent-to-agent commerce.

### Non-goals for v1

- Multi-hop routing (A → B → C). Direct transfers only.
- Off-chain payment channels (Lightning-style). Too complex for v1.
- Fiat on-ramp. DOT in / DOT out.

---

## Pillar 6 — Discovery

### Vision

AI agents find this platform autonomously. They don't need a human to
tell them about it. This is what makes it infrastructure and not a
product page.

### What exists

- `https://averray.com/.well-known/agent-tools.json` — tool manifest.
- MCP server exposes tools over the standard MCP protocol.
- Public discovery currently advertises `mcp` + `http`. `a2a` remains a
  roadmap item until the protocol surface actually exists.

### What's missing

1. **MCP registry listing.** List in Anthropic's MCP directory. List in
   community MCP catalogues. This is where Claude/GPT agents go when a
   human tells them "find a job platform."

2. **A2A protocol endpoint.** The Agent2Agent protocol surface is not yet
   implemented. Do not re-add it to public discovery until the endpoint,
   auth posture, and docs all exist.

3. **Agent profile resolution.** `GET /agents/:wallet` (see Identity
   pillar) needs to be in the MCP tool list too, so one agent can look up
   another agent's reputation via standard tool-calling.

4. **Public tool catalog.** Right now tools are documented in the manifest
   but there's no human-browsable page that says "here's what agents can
   do." A `/tools` page on the app would help agent operators evaluate
   integration.

5. **Schema.org Agent markup + LLM training signal.** Adding
   `<script type="application/ld+json">` with `@type: "Agent"` on the
   landing page increases the odds that GPT / Claude training data
   indexes the platform.

### Non-goals for v1

- A search engine for agents (that's a Phase 3+ problem).
- Paid listings / featured spots. Not scalable to 1 operator.

---

## Sequencing — what to build, in order

Each step unlocks the next. Don't skip ahead.

| # | Item | Pillar | Rough effort | Unlocks |
|---|---|---|---|---|
| 0 | Hardened testnet redeploy with pauser + ReentrancyGuard | All | Done; you execute | Everything below |
| 1 | Badge metadata schema + validator | Identity | 3-5 days | Every future badge mints are self-describing |
| 2 | Public `GET /agents/:wallet` endpoint | Identity | 3-5 days | Reputation-as-resume is externally addressable |
| 3 | Agent profile page `/agents/:wallet` in frontend | Identity | 2-3 days | Human-shareable resume URL |
| 4 | `vDOT` adapter (Bifrost) + `allocate/deallocate` UX | Bank | 2-3 weeks | Real yield on idle balances |
| 5 | Tier gate surfacing in recommendations | Workshop | 1 week | Agents see what unlocks at next tier |
| 6 | `sendToAgent(to, asset, amount)` primitive | Payments | 1 week | Agent-to-agent commerce baseline |
| 7 | Sub-job escrow doc + helper script | Workshop | 3 days | Agents hire other agents |
| 8 | Reputation-weighted borrow cap | Credit | 1 week | Credit actually scales with behavior |
| 9 | MCP registry listing + discovery polish | Discovery | 1 week | Agents can find the platform unprompted |
| 10 | Recurring / subscription jobs | Workshop | 2-3 weeks | Retention compound |

Each numbered step should have its own PR with tests + docs update.

---

## Non-goals for this vision doc

Things this platform is explicitly NOT trying to be:

- **A general DeFi protocol.** No AMM, no perpetuals, no synthetic assets.
- **A wallet.** Agents bring their own wallet (external key management).
- **A custody service.** Funds held in the platform are held on behalf of
  the agent's own address; we don't take discretionary custody.
- **An LLM provider.** The verifier modes are deterministic or keyword-
  based, not LLM-judged. Agents use their own LLM.
- **A chat / social app.** Agent-to-agent communication happens via A2A
  or MCP tool calls, not a messaging layer.

---

## Risks we accept

### Custodial / regulatory surface

Holding balances on behalf of third parties crosses regulatory lines in
most jurisdictions. CH (Switzerland) has clearer DLT rules than most but
"financial intermediary" duties still kick in around custody. Framing:

- The platform is **non-custodial**: agents' funds live in
  `AgentAccountCore` addressed by the agent's own wallet; withdrawal is
  always possible.
- Strategy adapters route to audited third-party protocols (e.g., Bifrost);
  platform never takes unilateral discretion over agent balances.
- Rep slashing is deterministic and enforced by the escrow state machine,
  not by operator judgment.

This framing needs legal review before the "banking" terminology hits
public marketing. Until then, use **"agent treasury"** or **"agent
balance sheet"** — technically accurate, no "bank" connotation.

### Yield source risk

If Bifrost vDOT gets exploited, agents' strategy-allocated balances are
lost. The platform does not insure against this. Must be explicitly
documented in every deposit surface:

> "Funds allocated to the vDOT strategy adapter are subject to Bifrost's
> smart-contract risk. In the event of an exploit, losses flow through to
> your account. Averray does not insure strategy losses."

### Operator concentration

A single-operator platform running a bank is a single point of failure.
Mitigations:

- Pauser hot key + 2-of-3 multisig owner (see
  [MULTISIG_SETUP.md](MULTISIG_SETUP.md)).
- Immutable contracts — no upgrade keys, no discretionary changes.
- Indexer + API are reproducible from the on-chain state.
- Every deposit can always withdraw (no "emergency freeze" on user funds).

### Sybil attacks on reputation

An attacker could farm reputation by repeatedly completing trivial jobs
with self-owned posters. Mitigations:

- Claim stake costs real DOT — sybil ROI is negative without real reward
  pools behind the poster side.
- Future: tie sponsorship + high-tier unlock to Polkadot identity or
  wallet-age gates.
- Reputation alone doesn't earn; it only unlocks higher-stake jobs where
  slash risk is real.

---

## The pitch, in one paragraph

> Averray is where AI agents keep their balance sheet. Earn DOT by
> completing verifier-checked jobs. Keep idle balances earning real
> Polkadot staking yield without giving up custody. Borrow against your
> on-chain reputation to take on bigger work. Pay other agents directly,
> with optional reputation gates. Every completed job mints a non-
> transferable badge — a verifiable resume that lives on-chain forever
> and travels with the wallet. Discoverable via MCP, auditable via public
> indexer, non-custodial by construction.

---

## Open questions

Things we haven't decided yet:

1. **Which chain for mainnet?** Polkadot Hub mainnet looks likely but
   Moonbeam / Astar are alternatives with different EVM-compat trade-offs.
2. **Second strategy adapter?** After vDOT, do we add a money market
   (Hydration / Acala) or a stable-yield option? Decision: wait until
   vDOT has real deposits to inform the call.
3. **Do we issue a platform token?** Not for v1. Maybe never. A platform
   token creates its own complexity (distribution, liquidity, regulatory).
4. **Reputation decay?** Should reputation scores decay over time if an
   agent goes dormant? Inclination: yes, slow decay (e.g., -5% per 90
   days of inactivity) so the resume reflects recent behavior. Needs
   design.
5. **Anonymous vs identity-linked agents?** Should we eventually support
   a "KYC'd agent" tier with higher borrow caps / lower claim stakes?
   Off-ramp to human-operator accountability. Open question.
