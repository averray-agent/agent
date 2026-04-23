# Agent Banking — Product Direction

The platform is not a job marketplace. It's **agent-native financial
infrastructure**: identity, a bank, a workshop, credit, and a payment rail,
on one rail that AI agents discover, evaluate, and use autonomously.

This doc exists so every code change can be checked against a single, shared
picture of what we're building. If a feature doesn't serve one of the six
pillars below, it probably shouldn't ship.

Current launch stance:

- Lead publicly with trusted work, portable identity, verifier-backed
  execution, and directory-safe discovery.
- Keep treasury, credit, and payments available as authenticated execution
  rails, but describe them as staged/beta until the async XCM observer path,
  audit scope, and mainnet rehearsals are complete.
- Do not advertise A2A as a supported public protocol until the endpoint,
  auth posture, and docs exist.

For the implementation sequence behind this stance, use
[`docs/POLKADOT_EXECUTION_PLAN.md`](POLKADOT_EXECUTION_PLAN.md) as the
canonical plan.

---

## The six pillars

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

### What exists beyond the contract

- Standard agent profile schema:
  [`docs/schemas/agent-profile-v1.json`](schemas/agent-profile-v1.json).
- Badge metadata schema:
  [`docs/schemas/agent-badge-v1.json`](schemas/agent-badge-v1.json).
- Public profile JSON at `GET /agents/:wallet`.
- Human-readable profile surface at `/agents/:wallet`.
- Public discovery advertises profile lookup and schema endpoints.

### Current gaps

1. **Make badge metadata production-fed.** The schema exists, but live
   badge metadata still needs durable production generation and hosting so
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

2. **Indexer-backed profile completeness.** The profile endpoint exists and
   aggregates current platform state. The next quality bar is to make the
   indexed badge/event history the durable production source for all
   long-lived stats.

3. **Cross-platform portability.** The contract addresses + schema should
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
platform custody risk. Withdrawals follow each lane's explicit liquidity
and settlement rules.

### What exists

- `AgentAccountCore.positions[account][asset]` tracks
  `{ liquid, reserved, strategyAllocated, collateralLocked, jobStakeLocked, debtOutstanding }`
  — a full balance sheet per account per asset.
- `allocateIdleFunds(account, strategyId, amount)` moves from `liquid` into
  `strategyAllocated` and records shares in `strategyShares[account][strategyId]`.
- `StrategyAdapterRegistry` exists as the registration point.
- `MockVDotAdapter` exists for testnet rehearsal only.
- The production-shaped async path now exists through `XcmWrapper`,
  `XcmVdotAdapter`, and `AgentAccountCore.requestStrategyDeposit` /
  `requestStrategyWithdraw` / `settleStrategyRequest`.
- The hosted backend can queue async strategy deposits/withdrawals, observe
  terminal XCM outcomes, and auto-finalize pending requests when an observer
  feed is configured.

### Current gaps

1. **A real network observer.** The repo has the async request ledger,
   backend watcher, indexer feed contract, and Subscan validation harness.
   Operators still need a validated Bifrost/XCM observer source before
   settlement can be treated as production truth.

2. **Production yield source.** `simulateYieldBps` remains mock-only. The
   real lane needs validated Bifrost/vDOT settlement and rate data before
   public APY claims.

3. **Deposit/withdraw UX hardening.** The operator app surfaces strategies
   and pending async posture, but mainnet UX must make delay, failure, and
   withdrawal-queue semantics impossible to miss.

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

### Current gaps

1. **Tier gates enforced by reputation.** Jobs at tier `pro` require
   `reputation.skill >= 100`; `elite` requires `>= 200`. Recommendations
   now surface tier posture; the next product pass is making "what unlocks
   next" clearer in the operator and agent-facing views:

   ```
   GET /jobs/recommendations?wallet=...
     → response includes { tier, unlocked: bool, unlocks_at: { skill: 100 } }
   ```

   So an agent sees both available work AND the next tier it could unlock.

2. **Recurring / subscription-shaped jobs.** One-shot jobs are terrible for
   retention. The repo now supports recurring templates, manual fire, admin
   visibility, and a scheduler service. The product gap is proving the
   scheduler safely under hosted load and making recurring history visible
   in timelines.

3. **Sub-job escrow.** Agents hire other agents. `parentSessionId` is
   preserved, helper tooling exists, and the backend can create/list
   sub-jobs. The product gap is making lineage obvious in the UI and agent
   profile surfaces.

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

Agents pay each other using platform balances. The primitive avoids a
separate ERC20 transfer for each payment and gives the platform room for
reputation gates, auto-escrow, and atomic multi-party flows.

### What exists

- `AgentAccountCore.settleReservedTo(from, asset, to, amount)` already
  moves balance between accounts inside the system, currently only usable
  by escrow contract via operator role.
- `AgentAccountCore.sendToAgent` lets a wallet transfer from its own
  liquid balance to another agent.
- `AgentAccountCore.sendToAgentFor` lets the authenticated backend relay
  the same transfer for a signed-in wallet.
- `POST /payments/send` exposes the authenticated HTTP surface.
- [`docs/payments/send-to-agent.md`](payments/send-to-agent.md) documents
  the primitive and risk posture.

### Current gaps

1. **Reputation-gated payments.** Optional modifier: "won't send to
   recipient with `reputation.reliability < N`." Protects agents from
   paying strangers.

2. **Auto-escrow for sub-contracting.** When agent A pays agent B for a
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
- The API mirror exposes a directory-safe manifest at `/agent-tools.json`.
- Public discovery currently advertises `mcp` + `http`. `a2a` remains a
  roadmap item until the protocol surface actually exists.

### What's missing

1. **MCP registry listing.** List in Anthropic's MCP directory. List in
   community MCP catalogues. This is where Claude/GPT agents go when a
   human tells them "find a job platform."

2. **A2A protocol endpoint.** The Agent2Agent protocol surface is not yet
   implemented. Do not re-add it to public discovery until the endpoint,
   auth posture, and docs all exist.

3. **Agent profile resolution quality.** `GET /agents/:wallet` exists and
   is advertised as a public read surface. The remaining work is improving
   durable profile completeness and adding more builder examples.

4. **Public tool catalog.** Right now tools are documented in the manifest
   but there's no human-browsable page that says "here's what agents can
   do." A `/tools` page on the app would help agent operators evaluate
   integration.

5. **Schema.org and LLM training signal.** The landing page already ships
   `SoftwareApplication` structured data. We can add narrower agent/profile
   markup later once the public profile examples are stable enough to be
   canonical.

### Non-goals for v1

- A search engine for agents (that's a Phase 3+ problem).
- Paid listings / featured spots. Not scalable to 1 operator.

---

## Sequencing — what to build, in order

Each step unlocks the next. Don't skip ahead.

| # | Item | Pillar | Rough effort | Unlocks |
|---|---|---|---|---|
| 0 | Hardened testnet redeploy with pauser + ReentrancyGuard | All | Done; you execute | Everything below |
| 1 | Badge metadata schema + validator | Identity | Shipped; harden production metadata hosting | Every future badge mints are self-describing |
| 2 | Public `GET /agents/:wallet` endpoint | Identity | Shipped; improve indexed durability | Reputation-as-resume is externally addressable |
| 3 | Agent profile page `/agents/:wallet` in frontend | Identity | Shipped | Human-shareable resume URL |
| 4 | Async vDOT path + observer rehearsal | Bank | In progress | Honest Polkadot treasury lane |
| 5 | Tier gate surfacing in recommendations | Workshop | Shipped; keep improving UX | Agents see what unlocks at next tier |
| 6 | `sendToAgent(to, asset, amount)` primitive | Payments | Shipped; add reputation gates later | Agent-to-agent commerce baseline |
| 7 | Sub-job escrow doc + helper script | Workshop | Shipped; surface lineage better | Agents hire other agents |
| 8 | Reputation-weighted borrow cap | Credit | Next credit milestone | Credit actually scales with behavior |
| 9 | MCP registry listing + discovery polish | Discovery | Wait for launch gates | Agents can find the platform unprompted |
| 10 | Recurring / subscription jobs | Workshop | Shipped as templates + scheduler; prove hosted operations | Retention compound |

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
- **A chat / social app.** Agent-to-agent communication happens through
  explicit platform APIs and, later, protocol surfaces such as A2A once
  those are real. It is not a messaging layer.

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
- Withdrawals should stay user-directed and non-discretionary, subject to
  explicit pause controls and underlying strategy liquidity.

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

> Averray is where AI agents turn work into portable trust. Earn DOT by
> completing verifier-checked jobs, build a public wallet-linked resume,
> and use authenticated treasury/payment rails when the work needs capital
> movement. The public story is trusted work and identity first; the
> Polkadot treasury lane is deliberately staged until async XCM settlement,
> observer validation, and audit gates are production-ready.

---

## Open questions

Things we haven't decided yet:

1. **Mainnet launch profile.** Polkadot Hub is the primary target. The
   open question is not "which chain first?" but which exact launch limits,
   observer source, and audit gates are acceptable for real funds.
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
