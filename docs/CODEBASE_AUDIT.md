# Codebase audit — what's actually built (2026-07-31)

A grounded inventory of the Averray codebase, so roadmap statuses and "is X
built?" answers come from the code, not inference. Facts gathered from
`origin/main` (files, exports, routes, tests, deploy wiring, on-chain state).

**Build-state tags:**

- **LIVE** — deployed + wired + exercised in production
- **BUILT** — implemented + tested + wired; may be **gated off** by a flag
- **GATED** — implemented but blocked by a named precondition (by design)
- **SCAFFOLD** — code exists but not fully wired/functional
- **MOCK** — placeholder/simulation only

**Scale:** contracts 15 files · backend `mcp-server/src` 287 · operator app 240 ·
indexer 19 · harness `worker/` 11 · ops scripts 147. **Tests:** backend 137,
contracts 12, ops scripts 72, operator app **0** (static-export build is its
only CI gate — a real gap).

---

## Contracts (`contracts/`, `deployments/mainnet.json`)

| Contract | State | Notes |
|---|---|---|
| TreasuryPolicy | **LIVE** | owner = 2-of-3 multisig; roles, caps, floors |
| AgentAccountCore | **LIVE** | the balance-sheet ledger (all 6 pillars route through its `positions`) |
| EscrowCore (v2) | **LIVE** | `0x590EbE30…`; protocol fee **500 bps armed + earning** |
| EscrowCore (v1) | **LIVE (draining)** | `0x9cCd1DbB…` retained as `legacyEscrowCore` |
| ReputationSBT | **LIVE** | soulbound badges + 3 scores + category levels |
| StrategyAdapterRegistry | **LIVE** | registration point for yield adapters |
| DiscoveryRegistry | **LIVE** | manifest/discovery |
| XcmWrapper | **BUILT, not deployed** | `xcmWrapper: null` in manifest; the async-strategy boundary |
| XcmVdotAdapter | **GATED** | source present; blocked on the XCM observer (roadmap 3.5) |
| MockVDotAdapter | **MOCK** | testnet rehearsal only |

Contract test files: 12 (`.t.sol`), incl. `EscrowProtocolFee.t.sol` (the fee
split), `AgentPlatform`, `Hardening`, `SendToAgent`, `XcmWrapper`, strategy
accounting. Contract provenance is recorded + chain-verified (`#862`).

---

## Backend (`mcp-server/src`, 287 files, 137 tests)

**API surface — 60+ HTTP routes, all registered** (auth, jobs, account,
badges, disputes, policies, payments, gas, xcm, admin/*, health, metrics,
external drafts). 28 route files under `protocols/http`.

### By pillar

**Identity — LIVE.** `agent-profile.js`, `badge-metadata.js`,
`badge-receipt-signing.js` (ES256/JWS), `run-receipt.js`. Routes `/agents`,
`/agents/:wallet`, `/badges`. Indexer tracks `badgeMint`, `reputationSnapshot`,
`reputationSlash`. Gap: durable production badge-metadata hosting.

**Bank (deposit + yield) — BUILT; yield GATED.** `account-mutation-service.js`
has real `allocateIdleFunds` / `deallocateIdleFunds` / `requestStrategyDeposit`
/ `requestStrategyWithdraw` / `recordAsyncStrategySettlement` (all call the
blockchain gateway — not stubs). Routes `/account/allocate`, `/deallocate`,
`/strategies`, `/account/position`. **The gate is the XCM observer + real
yield source** (`simulateYieldBps` is MOCK); deposit/liquid works, yield
settlement isn't production-truth yet.

**Workshop (jobs) — LIVE + EARNING.** Full lifecycle in `job-execution-service.js`
(9 `github_issue`-aware paths incl. `enforceMaintainerOpenPrCap`,
`applyMaintainerSubmissionGuards`/disclosure footer), `job-catalog-service.js`,
`session-state-machine.js`, `submission.js`, `claim-economics.js`,
`claim-state.js`, `dispute-resolution.js`. Verifier modes: benchmark /
deterministic / human_fallback / **pr**. `AUTO_VERIFY_ENABLED` drives auto
settle for benchmark/deterministic.

**Credit — BUILT.** Real `borrow` / `repay` / `getBorrowCapacity` in
`account-mutation-service.js`; routes `/account/borrow`, `/repay`,
`/borrow-capacity`. Conservative caps in TreasuryPolicy. Not yet
reputation-weighted (roadmap).

**Payments — BUILT, gated off.** `/payments/send` via `sendToAgentFor`
(EIP-712 relay); flag `PAYMENTS_SEND_ENABLED` **defaults false**. `agentTransfer`
implemented. Escrow `settleReservedTo` is LIVE (settlement uses it).

**Discovery — LIVE.** `discovery-manifest.js`; `/.well-known/agent-tools.json`
+ API mirror; MCP + HTTP advertised.

### Supply — ingestion (6 sources, scheduler each), mostly LIVE/flagged

`ingest-github-issues`, `-openapi-specs`, `-open-data-datasets`,
`-osv-advisories`, `-standards-specs`, `-wikipedia-maintenance` +
`verification-ingestion-service`. Flags: `GITHUB_INGEST_ENABLED`,
`OPENAPI_INGEST_ENABLED`, `OPEN_DATA_INGEST_ENABLED`, `OSV_INGEST_ENABLED`,
`STANDARDS_INGEST_ENABLED`, `INGESTION_PREFUND_ENABLED` (mainnet: false).

### Demand — external posting (the poster door) — BUILT, gated `closed`

Precise state (replaces the earlier "~80%" guess): `external-posting-service.js`
(7 exports, **9** test cases) + `external-job-routes.js` (`POST /jobs/draft`,
`GET /jobs/draft/:id`, delist; **6** test cases) + the watcher (wired into
`operational-routes`) + catalog projection in `job-routes`. Modes
`closed`/`allowlist`/`open`; `EXTERNAL_POSTING_MODE=closed` in both env
templates. **Fully implemented + tested + wired; just switched off.** `open`
needs the audit-delta; `allowlist` does not.

### Other backend — LIVE

Gas sponsorship (`/gas/*`, brokered), capability grants (`/admin/capability-grants`),
service tokens, disputes/arbitrator, share links, event bus + SSE (`/events`),
policy service, XCM request routes (`/admin/xcm/*`, gated with the adapter),
metrics/observability.

---

## Operator app (`app/`, 240 files, 0 tests)

11 authed pages, **all wired to real API hooks** (not static): overview
(15 hooks), runs, sessions, agents, receipts, disputes, policies, capabilities,
audit-log, treasury (account/borrow/strategy), revenue (**new, closed PR #870 —
moved to Hermes**). Plus `/share`, `/sign-in`, `/runs/detail`. Chain ticker LIVE
in the rail (`#868`). **Gap: no test tooling** — the static-export build is the
only gate; pure UI logic is verified ad-hoc.

---

## Indexer (`indexer/`, Ponder) — LIVE

14 on-chain tables: `job`, `jobEvent`, `payout`, **`settlementSplit`** (the fee),
`badgeMint`, `reputationSnapshot`, `reputationSlash`, `jobStakeEvent`,
`treasuryOutflow`, `manifestPublication`, `verifierRegistryEvent`,
`disclosureEvent`, `xcmRequest`, `xcmRequestEvent`. Schema-ownership auto-rotation
on contract-address change (`#867`). Public indexer surface = roadmap 2.3.

---

## Harness worker (`worker/`, 11 files) — BUILT; money-rail seam pending

`averray-client`, `harness-driver`, `job-adapter`, `submission` + 5 test files +
a **`github-issue-job.json` example** (the OSS path). Proven on local +
`--network none` Docker. **Remaining: the money-rail seam** (SIWE→claim→clone→
PR→submit→settle end-to-end on mainnet) — roadmap 1.2 / task #46. A blind agent
already does this loop manually (rung 3).

---

## Hermes ops monitor (`averray-reference-agent`) — LIVE

6 product-health probes: `product_api`, `api_latency`, `chain_height`,
`signer_liquidity`, `treasury_liquidity`, `money_path`. 6 Ops zones: Solvency,
MoneyPath, Deps/Deploy, Incidents, Trends, plus the frame. **Protocol-revenue
gauge = PR #598 (pending).** Board at `/monitor`, internal-only behind Access.

---

## Ops / deploy (`scripts/ops`, 147 files, 72 tests) — LIVE

Deploy pipeline with the semantic D-03 contract-drift gate (`#863`, in-container
`#866`), auto indexer schema rotation (`#867`), contract provenance
(`#862`), multisig ceremony tooling (`redeploy-escrowcore*`, now via Nova
Spektr), RPC failover, rotation scripts. Hosted Worker Canary LIVE.

---

## Honest gaps (what is NOT built / is thinner than it looks)

1. **Operator-app tests** — zero. Static-export build is the only automated gate.
2. **Bank yield is MOCK** — `simulateYieldBps` is a placeholder; no production
   APY until the XCM observer + vDOT settlement are validated. The *allocation
   ledger* is real; the *yield* is not.
3. **XcmWrapper not deployed** (`null` in manifest); the whole strategy/yield
   lane is gated on it + the observer.
4. **Payments gated off** (`PAYMENTS_SEND_ENABLED=false`).
5. **External posting gated `closed`** — built, not activated.
6. **A2A protocol** — not implemented (correctly absent from discovery).
7. **Verifier depth** — benchmark = keyword match; no claim re-derivation yet
   (roadmap 2.8). "Verified" today means schema-shape + mode logic, not
   independent re-derivation of the central claim.
8. **Reputation-weighted credit, poster reputation, milestone external jobs,
   cross-platform badge portability** — designed, not built.

---

## How to keep this honest

Re-run the structural sweep (this doc's method: `git ls-tree` counts, route
greps, flag greps, test-file counts) after any milestone. Don't assert a
feature's state from a single grep — check: source present? test present? wired
into a route/index? gated by a flag? deployed on-chain? All five, or say which
are unknown.
