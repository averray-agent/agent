# Averray roadmap — the board we build to

The single coordination board for everything post-launch. One owner per row,
honest statuses, edit only your own rows (same discipline as
`AUDIT_REMEDIATION.md`).

**North star:** [`AGENT_BANKING.md`](AGENT_BANKING.md) — the six pillars and *why*
they compound. This board organizes the work **by those pillars** so every row
maps to the product picture. The pre-launch build plan
([`POLKADOT_EXECUTION_PLAN.md`](POLKADOT_EXECUTION_PLAN.md)) is **superseded** —
it got us to mainnet; this board is what's next.

Status legend: **live** (in prod) · **next** (build now) · **gated** (blocked on a
named precondition, by design) · **watch** (external, monitor only).

---

## Where we are (2026-07-31)

**Mainnet is LIVE and EARNING.** Averray runs on Polkadot Hub (chainId 420420419).
The Workshop pillar is fully live and now takes a **5% protocol fee** on paid jobs.

**Banked since the flip (2026-07-27 → 07-31):**

- **Cutover complete** — testnet retired, mainnet live and durable.
- **EscrowCore v2 shipped end-to-end** — deployed + bytecode-verified, wired via
  multisig, cut over to production, and **proven settling a real job**.
- **Protocol fee LIVE at 500 bps** — armed on-chain, then **dogfooded and
  independently verified**: the audited *poster-side additive* model — poster
  reserves reward × 1.05, **worker receives the full advertised reward**,
  treasury receives 5%. Starter/earn-from-zero jobs stay fee-exempt by design.
  Fees accrue under the 2-of-3 treasury multisig `0x01E6eed8…C874C`.
- **Validation ladder rung 3 (blind agent) passed** across multiple model
  families; earn-from-zero proven by strangers.
- **Deploy pipeline hardened** — the D-03 contract-surface gate is now
  *semantic* (compares live-chain bytecode to a recorded provenance manifest,
  not file paths), runs its checker in-container, and auto-rotates the indexer
  schema on a real contract-address change. Contract provenance is recorded and
  chain-verified.
- **Multisig signing solved** — ceremonies now run through **Nova Spektr**
  (auto-timepoint, decoded-call review, no hex-relay); Claude verifies the call
  hash out-of-band every time.
- **Live block-height ticker** shipped in both the Hermes ops board and the
  operator app rail.

---

## Pillar 1 — Identity (the linchpin: LinkedIn for agents)

Reputation is what turns this from "vault + marketplace" into infrastructure
agents integrate with because their resume lives here. It gates every other
pillar (tiers, credit risk, payment trust).

| State | Item | Owner |
|---|---|---|
| live | ReputationSBT soulbound badges minted per job; 3 orthogonal scores (skill/reliability/economic); per-category levels; indexer tracks Badge/Reputation events | — |
| live | Public profile `GET /agents/:wallet` + human page `/agents/:wallet`; agent-profile + badge schemas; **badge receipts ES256/JWS-signed** (verify-signature in-browser) | — |
| next | Production badge-metadata hosting — every badge self-describing from a durable source | Codex |
| next | Indexer-backed profile durability — indexed badge/event history as the source of truth for long-lived stats | Codex |
| next | Tier-vocabulary consolidation across list/drawer/backend (was #765) | Codex |
| later | Cross-platform badge portability — document contracts+schemas so third parties can mint/read compatible badges | later |

## Pillar 2 — Bank (deposit + yield — the money-market)

**The retention moat.** Agents park idle balance and earn real yield without
platform custody risk; the same balance backs credit and job stakes. The
account model is uniform: **every holder — agent or the protocol treasury — is
an `AgentAccountCore` position** (`liquid / strategyAllocated / collateralLocked
/ reserved / jobStakeLocked / debtOutstanding`). Build every money view as a
*position view* and never fragment an account's balance sheet — that keeps the
whole pillar rebuild-proof.

| State | Item | Owner |
|---|---|---|
| live | Full per-account balance sheet; `allocateIdleFunds` (liquid→strategy); StrategyAdapterRegistry; async XCM path (`XcmWrapper`/`XcmVdotAdapter`, `requestStrategyDeposit/Withdraw/settle`); backend queues + auto-finalizes async requests when an observer feed is set | — |
| **gated** | **Real network observer** — validated Bifrost/XCM observer source before settlement is production truth. *This is the gate for the whole pillar.* | Codex |
| gated | Production yield source — `simulateYieldBps` is mock; needs validated vDOT settlement + rate data before any public APY | Codex |
| next | **Protocol-revenue view** — surface the treasury multisig's position (fees earned) as its own operator-app view, honestly "held under 2-of-3, yield-eligible when this pillar lands." Reuses the position-view pattern; forward-compatible with treasury yield | Claude |
| next | Deposit/withdraw UX hardening — delay, failure, withdrawal-queue semantics impossible to miss | Codex |
| gated | Strategy-adapter audit surface — one canonical adapter first; each new adapter is a fresh audit item | Codex |
| later | Yield-portfolio v2 (GDOT, opt-in, post-vDOT) — `docs/strategies/hydration-gdot.md` | later |

**Non-goals (v1):** multi-asset deposits, leveraged/complex strategies,
vault-of-vaults. It's a savings account, not a hedge fund.

## Pillar 3 — Workshop (jobs + escrow) — LIVE + EARNING

The core loop, now revenue-generating. What's left is verifier depth, demand,
and delivery.

| State | Item | Owner |
|---|---|---|
| live | Full job lifecycle (single-payout + milestone, claim stake, timeout, rejection, dispute, arbitration); tier gates; verifier modes; recurring templates; sub-jobs | — |
| live | **EscrowCore v2 + 5% protocol fee** — cut over, dogfooded, verified (poster-side additive) | — |
| next | **Verifier claim re-derivation** — verifier re-derives central claims (fetch spec, count paths), not just schema-shape; gates delivery D1 **and** adversarial-test depth. High leverage | Codex |
| next | **Demand-adaptive reward pricing** — price ingested-job rewards by value + live claim demand, back off to zero when nothing's claimed; reward bank stays the hard cap | Codex (design w/ Claude) |
| next | **Delivery loop D0** — verified work reaches its originator (queue + report adapters + operator page); carries Averray's signature, gated harder than payout | Codex |
| open | Adversarial test (rung 4) — garbage/claim-spam/injection; economics must hold; protocol written, exposure capped by reward bank | Claude + Codex |
| later | Delivery D1/D2 (auto modes, upstream bot approvals) | later |

## Pillar 4 — Credit (borrow against reputation + collateral)

Conservative launch profile; scales with reputation later. Reputation IS
collateral — the carrot that makes agents maintain it.

| State | Item | Owner |
|---|---|---|
| live | `borrow`/`repay`, `getBorrowCapacity`; per-account cap 25 USDC + 200% collateral ratio; debt-first settlement; debt-gated withdrawal | — |
| next | A *reason* to borrow — first use case: borrow to meet a higher-tier job's claim stake | Codex |
| later | Reputation-weighted borrow cap (0→50→200→1000 USDC by skill tier) | later |
| later | Hydration money-market migration — route collateralized borrowing through Hydration, not Averray-as-lender (`docs/HYDRATION_BORROW_MIGRATION.md`) | later |

**Non-goals (v1):** variable rates, multi-asset collateral, credit delegation.

## Pillar 5 — Payments (agent-to-agent)

The primitive for agent-to-agent commerce; the killer case is auto-escrowed
sub-contracting.

| State | Item | Owner |
|---|---|---|
| live | `sendToAgent` / `sendToAgentFor` (EIP-712 authorized relay); `POST /payments/send`; escrow-only idempotent `settleReservedTo` | — |
| next | Reputation-gated payments — optional "won't send to reliability < N" | Codex |
| next | Auto-escrow for sub-contracting — hold A→B payment, release on verifier approval (Workshop machinery, micro-scaled) | Codex |

**Non-goals (v1):** multi-hop routing, payment channels, fiat on-ramp.

## Pillar 6 — Discovery (agents find us autonomously)

What makes it infrastructure, not a product page.

| State | Item | Owner |
|---|---|---|
| live | `.well-known/agent-tools.json` manifest + directory-safe API mirror; MCP + HTTP advertised; discovery registry | — |
| next | **MCP registry listing** — Anthropic's MCP directory + community catalogues; where agents go when told "find a job platform" | Pascal + Codex |
| next | Public `/tools` page — human-browsable "here's what agents can do" for operators evaluating integration | Codex |
| next | Agent-profile resolution quality + more builder examples | Codex |
| gated | A2A protocol endpoint — not re-added to public discovery until endpoint + auth + docs all exist | later |

---

## The business frontier — demand (cuts across pillars)

**The one that decides whether this runs itself.** Supply is bootstrapped by
ingested public-good jobs (which *we* fund from the reward bank — a cost). The
platform is self-sustaining only when **fee revenue from paid jobs > operating
cost** (reward-bank subsidy + gas + infra). That flips positive with *paid
external-poster volume*, nothing else.

| State | Item | Owner |
|---|---|---|
| next | **Open the poster door** — `EXTERNAL_JOB_POSTING` mode=open (design in `EXTERNAL_JOB_POSTING_DESIGN.md`; the contract already supports any-wallet posting — the gap is one backend layer). Audit-delta lands before mode=open | Pascal + Codex |
| open | **Pick the wedge** — who posts paid jobs? Candidates: paid data-audit jobs, verifier-as-a-service for other agent platforms, OSS-maintainer bounty escrow. Delivery (Workshop) is the poster-acquisition path | Pascal (strategy) |
| later | Self-sustaining flywheel wiring — route a share of fees to top up the reward bank (fees → free jobs → agents → posters → fees); only once paid volume justifies it | Pascal |

---

## Agent-economy track — interop, identity, and delivery

This track is deliberately multi-provider. It should interoperate with the agent-payment
market without coupling Averray to any one wallet vendor or identity provider.

| Gate | Item |
|---|---|
| post-G4 | **Agent-payment interop survey + poster ramp** — investigate the managed-wallet/x402 landscape (Cloudflare Wallets, Coinbase CDP/AgentKit, Privy, Crossmint, Skyfire, and peers), then design one gateway that lets externally-walleted agents fund job postings; compatibility with most, coupling to none. |
| post-G4 | **Attested-identity waiver lever** — externally-attested agent identities earn richer waiver/tier treatment; anonymous zero-capital arrival stays untouched. |
| first-send mechanism + beachhead C-rungs | **Delivery-back: return the done job to the address it came from** — completed OSS-bounty jobs post exactly one comment on their origin issue containing a summary, branch link, and signed settlement receipt, then open a PR citing the issue and receipt. One revision round stays in bounty scope. Averray never touches issues that did not fund it. Claude supplies the spec when either dependency unparks. |

---

## Validation ladder (unbiased testing)

The five-rung ladder from `project_postlaunch_validation`. Each rung tests a
different bias.

| Rung | State |
|---|---|
| 1 · scripted smoke | done (pre-flip) |
| 2 · harness worker (money-rail seam, `worker/HANDOFF.md` #790) | **next** — one real mainnet job end-to-end; Codex |
| 3 · blind agent (zero context, public info only) | **done** — passed across model families |
| 4 · adversarial agent | ready — protocol written, run week-one; Claude + Codex |
| 5 · real strangers (friendly beta → open) | after 4 |

---

## Cross-cutting — ops, hardening, standing watches

| State | Item | Owner |
|---|---|---|
| next | **Ops sweep**: proxy DNS through Cloudflare (apex/API/app point straight at the VPS, no DDoS shield); revoke the 2026-06-13 leaked SA; second mainnet eth-rpc backup for `PRODUCT_HEALTH_RPC_BACKUPS`; CSP for marketing + operator app; mount Caddy config *dir* for atomic cutovers | Pascal |
| next | **JWT TTL ≤1h** — automated refresh-flow rotation to replace the hand-minted 30-day admin JWT (groundwork #672/#808) | Codex |
| deferred | Treasury withdrawal convenience — `setTreasuryAccount` to an EVM-accessible treasury once accrued fees justify it; until then fees accrue safely under 2-of-3 | Pascal |
| scheduled | Secrets calendar — RA certs 2026-10-12, GitHub PAT 2026-10-13, SA tokens ~2026-09-11; batch the October renewals | Pascal |
| **v2 remainder** | Revoke v1 EscrowCore roles once backend + indexer report zero live v1 jobs (Spektr ceremony) | Pascal + Claude |

**Standing watches:**

- **Passet Hub → permanent Asset Hub migration** could force a redeploy (like
  V1→V2). The **Polkadot Products Devnet** (Paseo-operated, mirrors the coming
  production network) is the early-warning channel — periodic check + forum.
- **Reward-bank balance is the spend cap**; settlement pauses at zero
  (`signer_liquidity_short`). Top up deliberately, never automatically.
- Every prod deploy verifies public `/health` chain ID in the durable Caddy
  selector; keep the assertion + auto-rollback enabled.
- Keep the owner multisig above the existential deposit while it owns contracts
  (AutoMapper unmaps reaped accounts).
- **The kernel/money-rail boundary:** the harness never touches signer, wallet,
  escrow, stake, or payout. Claiming/settling stays a separate non-LLM service.

---

## Horizon 3 — grow it (months, cross-pillar)

| State | Item | Owner |
|---|---|---|
| in progress | Harness worker as a standing earner — `agent-harness` Phases 6–7; worker inherits skills/learning (Track-A) | Track-A |
| open | Hermes as orchestrator — operator copilot routes work to Codex/Claude workers (`HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`) | Pascal + Hermes |
| watch | `.dot` domains as agent identity — human-readable names, resolved in profiles/badges; adopt when live via Products Devnet → mainnet | later |
