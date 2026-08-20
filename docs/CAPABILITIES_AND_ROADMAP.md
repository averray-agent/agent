# Averray — Capabilities & Roadmap

**Snapshot date:** 2026-08-19 · **Maintainer:** Claude (architect) · **Network:** Polkadot Hub mainnet (chainId 420420419) + Base (eip155:8453) for Verify payments
**Maturity vocabulary (strict):** **PROVEN** = exercised live with on-chain/tx evidence · **LIVE** = deployed and operating · **MERGED** = on main, not yet deployed/ceremonied · **DESIGNED** = ratified decisions, packet exists · **PLANNED** = on the roadmap, not yet designed.

---

## A. What the platform can do today

### The two front doors (the pivot, built)
- **Averray Verify — PROVEN PAID, door ARMED.** `git-patch-tests-v1@1` listed publicly at 5 USDC on Base. First capture 2026-08-19: x402 challenge → offline EIP-3009 authorize → sealed-runner execution → `approved` → capture tx `0xaf8f6175…` → public receipt `0x8a99c2e1…`. **Inconclusive never bills — proven live twice** (once under a genuine runner failure, once rehearsed), each with a portable receipt of *not* charging. External paid runs: **zero** (the capture was our rehearsal; the honest count stands).
- **Averray Proof-to-Pay — LIVE** (2026-08-19): bring-your-own-counterparty agreements. Buyer names the provider (`designatedClaimants`, exactly one checksummed address), funds via the existing poster door; escrow releases on PASS only. One shared gate binds preflight and claim (divergence structurally impossible); designated jobs never read as open supply; progression valves bypassed, claim stake stays; zero retention — the platform's take is the poster fee. Pilot caps **5 concurrent / 25 USDC**, fail-closed with named refusals.
- **Work receipt — PROVEN** (`averray.work-receipt.v1`): content-addressed, ES256-signed, public at `averray.com/receipts/:id`. Reconciliation enforced in the builder: `reward = worker + retention`, `posterTotal = reward + fee`, intent/settlement parity. Verify receipts share the same canonicalisation with **no settlement section**; even degraded paths self-describe (`chain_unavailable_fail_open`).

### Execution isolation
- **Witness runner service — LIVE**: verification executes in a no-listener container behind a **default-deny Docker admission proxy** (raw socket terminates at the proxy; sandbox containers are pinned-image, user 65532, `NetworkMode: none`, read-only rootfs, all caps dropped, binds confined). Docker-socket-into-the-backend is **refused permanently**. Fail-degrade: a dead runner ages runs to `inconclusive(runner_fault)` and bills nothing. CI proves the real fixture **inside the built images**.

### Marketplace core (Fulfill)
- **Job lifecycle end-to-end — PROVEN** (post → claim → submit → auto-verify → settle); external workers have earned real money (42 payouts/12h peak; Ash case study). **Deliverables are patch-shaped, never PRs on third-party repos — RATIFIED.**
- **Curated lanes — LIVE** with D3 budgets **plus the backlog throttle**: a lane stops posting once its unclaimed inventory hits its cap (liveness 2 / oss 3 / benchmark 2), resumes on a claim; disposable proof jobs (the canary) are exempt from the inventory bound but still pay the budget. Spend bounds money; backlog bounds inventory.
- **External poster door — LIVE**; x402 poster ramp PROVEN. **Disputes — LIVE** (7-day window, arbitrator, splits).

### Money rails & fee era
- **EscrowCore v3 — PROVEN** (retention + poster fee, first revenue 2026-08-16; cancel both directions). **Earnings door — PROVEN** (self-signed withdrawals). **Treasury — LIVE** (2-of-3 multisig).
- **Reward bank — measured, leaks closed**: burn was three regimes — drip (~0.25/day), posting bursts (−2.0/6h, jobs prefund at POST), and **flat zero since the throttle** (18h+ unmoved at 11.275 liquid). Canary self-recovers its payout. Runway: indefinite at zero demand; ~12 days at 3 claims/day; top-up trigger = liquid < 7 days at trailing claim rate. 5.05 reserved backs the standing board (reclaimable by archiving).
- **Verify revenue pot (Base): 6.05 USDC** at the payTo — 5 of it rehearsal, never presented as revenue. Sweep-to-Hub: DESIGNED-not-built; until the first evidenced sweep, verify revenue is its own line.

### Bank, credit, treasury truth
- **DepositPool v2 — LIVE** (cost-basis, caps 1,000/100, D0 vesting); yield epoch 1 PROVEN with honest write-off; first external depositor live.
- **Credit L1 — FULL LIFECYCLE PROVEN** (2026-08-18): pledge 501,328 shares → originate 0.30 → repay → **pledge released, pool made whole exactly** (loan `0x7a79b2da…`, status Repaid). Found and fixed on the way: the CreditPool was deployed-but-never-seeded — `contributeOperatorPrincipal` 1.50 now in (deployed ≠ operational). **CreditBook L2/L3 — MERGED, ceremony pending** (L3 flag-off).
- **Treasury tiles — LIVE on state reads** (events from multisig writes are invisible to `eth_getLogs` — structural, #1121 closed): Capital at Work derives `totalAssets − idle`; unreadable feeds render **Unknown, never a confident zero**. Current posture **Amber, honestly**: both Hydration adapters read `approvedStrategies=false` while holding real capital — the §8 decision.
- **Hydration positions — CONFIRMED VENUE-SIDE**: 14.960236 aUSDC total = v1 lane **10.000001** (operator capital, pre-pool, recall DECIDED) + pool lane 4.950004 + accrual at exactly ~5% APY. The board still under-reports (sums only the pool lane) until recall or the multi-lane summing fix.

### Worker progression, trust, operations
- **Four-valve ladder — LIVE** (S/E/D/D0); designated claims bypass valves by design. **Reputation SBTs, bonds/slashing, VerificationContract v1.1 source binding — LIVE.**
- **Canary — LIVE, GREEN, self-funding**: recovered payouts, `disposableProof` exemption, first green (#631) proved the fix against the saturated backlog it broke on.
- **Deploy pipeline — weather-proofed** (2026-08-19): transient transport failures (curl timeout, 5xx, the observed RPC 404, op-inject 502) retry bounded with logged reasons; **assertion failures never retry** (drilled); fail-closed unchanged. Five of the previous six red deploys were weather; this closes the class.
- **Security posture**: KMS-only signing, Roles Anywhere, 2-of-3 ceremonies with hash-verify law, gitleaks, internal audits remediated. **External audit: OPEN — the hard gate before general availability.** New standing law: green CI ≠ boots in its container — cross-package changes need container-level CI proof.

### Distribution
- MCP front door (SIWE, registry-listed), discovery manifest (+ `/verify/profiles`), transparency page, operator app. **Public product pages COMMISSIONED 2026-08-20** (gate amended by Pascal: content discipline replaces page absence — no traction claims, demo receipts labeled, numbers fetched live; packet `PACKET_PUBLIC_DEMAND_SURFACES.md`). Until it ships, the demand side is still invisible at every discovery surface.

---

## B. In flight / queued (owners)

| Item | State | Next step |
|---|---|---|
| **Outreach — 19 conversations, re-segmented 8/6/6** | Pascal, in progress | Both products now demo with live receipts |
| Epoch-2 ceremony §A: recall the v1 lane's 10.0 USDC | Runsheet written; **recall driver missing** | Codex builds + dry-runs the driver; Pascal signs; Claude gates |
| §8 multisig batch — now FOUR leg groups | Queued | v1/v2 revocations · v3-twin roles · `perAccountBorrowCap→0` · **approvedStrategies decision** (answer "is it enforced?" first) |
| CreditBook L2 deploy ceremony | Merged, unceremonied | Schedule; D-03 manifest at ceremony |
| Verify profiles 2–3 (`structured-output-evidence-v1`, `mcp-failure-semantics-v1`) | DESIGNED (packet §2) | Dispatch after P2P settles; MCP profile is the largest build |
| ERC-8004 registration (#236) | Ratified | After outreach #2; receipts as validation payload |
| ApprovalGrant fields (#238) | Ratified schema-only | Rides next credit-surface PR |
| Board multi-lane capital summing | Known gap | Small; or moot after recall |
| `platform_fault` immediate stake return; `paymentKey` replay test | Recorded follow-ups | Small PRs, non-blocking |
| Base→Hub revenue sweep design | Needed before real Verify revenue | Explicit, evidenced transaction; never implied |

## C. Roadmap (decided, gated, or planned)

- **Outcome-assurance pivot — EXECUTING AHEAD OF PLAN.** Phase R (receipt) PROVEN · Phase V profile 1 PROVEN PAID · Phase P (Proof-to-Pay) LIVE — all inside 48h of ratification. Remaining: V profiles 2–3, then the gated demand engine (GitHub issue-to-bounty, **gate: ≥1 external paid run**; MCP monitoring, gate: ≥3 paid runs).
- **30-day experiment (due 2026-09-11):** criteria unchanged — 10 submit · 5 paid · 3 repeat · ≥1 BYO · <15min · receipts embedded. Scoreboard current: **external paid runs 0 · BYO agreements 0** — the machine is built; the experiment is now entirely demand-side.
- **Swiss memo — event-triggered** (≥5-figure aggregate held third-party funds; scoping note + named counsel only until then; not a failed Sep-11 gate absent the trigger).
- **Credit ladder:** L2 cohort → L3 flag-on → creditBroker (banked) → backing agents (§9 gate now MET by the proven L1 loop — surveillance answer still owed) → Rail-2 (memo-gated).
- **Deferred with explicit gates:** routing API (≥50 external receipts) · validator marketplace (3 profiles × repeat payers) · receipt warranty (measured invalid rate + legal; fee-refund only) · trust primitives T2–T8 as before · external audit engagement.

## D. Standing laws (the short list)

Truth-boundary: never look more live than we are; self-traffic never reads as demand; rehearsal money is never revenue · patch-shaped deliverables, never PRs on repos we don't own; no write credentials on third-party repos · Docker control never in the internet-facing backend · inconclusive is never billed; `workerConsequence: none` for platform faults · caps fail closed with named reasons, never silently · dry-run first; evidence over exit codes; copy event signatures from the ABI, never retype; a zero-result probe is suspect until a known-positive matches · green CI ≠ boots in its container · one narrow PR per change; ceremonies verified against origin/main + chain before execution · keys never touch Claude; Pascal signs everything that moves money.
