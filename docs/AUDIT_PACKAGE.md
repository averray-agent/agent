# Audit Package

A single document for external auditors. Everything needed to evaluate the
system lives either here or at the paths cited — no "ask us" deliverables.

---

## 1. Scope

**In scope** (Solidity):

- [`contracts/TreasuryPolicy.sol`](../contracts/TreasuryPolicy.sol) — central admin config + pause
- [`contracts/AgentAccountCore.sol`](../contracts/AgentAccountCore.sol) — per-account balance, collateral, job stake, borrow/debt
- [`contracts/EscrowCore.sol`](../contracts/EscrowCore.sol) — job lifecycle, milestone + dispute flow
- [`contracts/ReputationSBT.sol`](../contracts/ReputationSBT.sol) — non-transferable reputation badges
- [`contracts/StrategyAdapterRegistry.sol`](../contracts/StrategyAdapterRegistry.sol) — strategy registration
- [`contracts/lib/ReentrancyGuard.sol`](../contracts/lib/ReentrancyGuard.sol) — vendored non-reentrant modifier
- [`contracts/lib/SafeTransfer.sol`](../contracts/lib/SafeTransfer.sol) — SafeERC20-style transfer helpers
- [`contracts/interfaces/IStrategyAdapter.sol`](../contracts/interfaces/IStrategyAdapter.sol)

Solidity version: **0.8.24** (via [foundry.toml](../foundry.toml)). No
external libraries beyond the two files under `contracts/lib/`.

**In scope** (off-chain, auxiliary — flagged as non-canonical):

- [`mcp-server/src/auth/`](../mcp-server/src/auth) — SIWE + JWT flow
- [`mcp-server/src/core/state-store.js`](../mcp-server/src/core/state-store.js) — Redis/memory state backing
- [`mcp-server/src/protocols/http/server.js`](../mcp-server/src/protocols/http/server.js) — HTTP adapter

**Out of scope**:

- Frontend (`frontend/`) — no trust boundary; all authorization decisions
  happen server-side or on-chain.
- Indexer (`indexer/`) — Ponder-based; read-only derivation of on-chain state.
- Deployment scripts (`scripts/`) — operator tooling; no runtime trust.
- Pimlico gas-sponsor integration (`mcp-server/src/services/pimlico-*`) —
  feature-flagged, disabled on all current deployments.

---

## 2. System overview

Three-layer stack:

1. **Solidity contracts** on Polkadot Hub (Ethereum-compatible).
2. **mcp-server** — Node.js service exposing HTTP, MCP, and A2A protocols.
   Authenticated via Sign-In with Ethereum (EIP-4361) → HS256 JWT.
3. **Frontend** — vanilla JS served as static files.

A worker's lifecycle:

```
  SIWE sign-in                  On-chain escrow
  ───────────                   ───────────────
   wallet ── POST /auth/nonce ── server ── nonce ─── wallet
   wallet ── signs SIWE msg ─────────────────────
   wallet ── POST /auth/verify ── server (JWT issued)
                                   │
                                   ├── POST /jobs/claim  ── EscrowCore.claimJob
                                   │   └── locks claim stake via AgentAccountCore
                                   ├── POST /jobs/submit ── EscrowCore.submitWork
                                   └── POST /verifier/run ─ EscrowCore.resolveSinglePayout
                                       ├── approved → settles reward + mints SBT badge
                                       └── rejected → opens dispute window
```

Trust boundary: all mutating calls to `EscrowCore` and `AgentAccountCore`
originate from a server-side signer; the `serviceOperators` allowlist on
`TreasuryPolicy` gates privileged cross-contract calls.

---

## 3. Trust model

### Roles

| Role | Identity | Capability |
|---|---|---|
| `owner` | 2-of-3 multisig (native pallet) on mainnet | All admin on `TreasuryPolicy` |
| `pauser` | 1-key hot EOA | Only `setPaused(bool)` |
| `serviceOperators` | `EscrowCore`, `AgentAccountCore` contract addresses; server signer optional | Privileged reserve/release/settle calls on `AgentAccountCore`; `recordOutflow` on `TreasuryPolicy` |
| `verifiers` | Designated EOA(s) configured by owner | `resolveSinglePayout`, `resolveMilestone` |
| `arbitrators` | Designated EOA(s) | `resolveDispute` |

### Trust assumptions

- **Owner key (multisig)** is honest and available. Loss of 2/3 keys means
  the stack is un-configurable; see [MULTISIG_SETUP.md](MULTISIG_SETUP.md)
  recovery section.
- **Pauser key** is available. Its only power is pausing; compromise lets
  an attacker grief by pausing but cannot drain funds.
- **Verifier key** follows the verifier logic honestly. A malicious verifier
  can reject valid work and trigger a dispute; they cannot steal funds.
- **ERC20 tokens** on the approved-asset list are well-behaved modulo the
  SafeTransfer wrapping (rebasing tokens are NOT supported; fee-on-transfer
  tokens are NOT supported).

### Adversary model

We expect auditors to consider:

- Worker races / double-claim attempts on a single job.
- Poster-side griefing (e.g., funding then cancelling, interfering with
  milestone settlement).
- Verifier collusion with poster or worker.
- Reentrancy via malicious ERC20 hooks (guarded by `ReentrancyGuard` but
  please test adversarial token contracts).
- Unauthorized operator / verifier / arbitrator registration.
- Pause bypass or state-machine desync between pause and unpause.

---

## 4. Key invariants

In the order we'd like auditors to break:

1. **Funds are never double-spent.** `settleReservedTo` decrements
   `position.reserved` before transferring; `settlementExecuted[jobId][key]`
   is set before settlement to prevent replay.
2. **Claim stake cannot exit the system without resolution.** Every path
   that decrements `jobStakeLocked` either releases to liquid
   (`releaseJobStake`) or slashes (`slashJobStake`).
3. **Borrow capacity respects `minimumCollateralRatioBps`.** `_isHealthy`
   must reject any operation that would drop collateral ratio below the
   configured minimum.
4. **Reputation is monotonic modulo slashing.** `updateReputation` only
   raises; `slashReputation` only lowers and saturates at zero.
5. **Milestone array is bounded.** `MAX_MILESTONES = 32` enforced in
   `createMilestoneJob` (prevents unbounded loop in `resolveMilestone`).
6. **Pause halts all value movement.** Every mutating function in
   `EscrowCore` and `AgentAccountCore` carries `whenNotPaused`.
7. **Non-re-entrancy.** External calls happen after state mutation
   (CEI ordering); `nonReentrant` modifier guards callbacks from malicious
   tokens.

---

## 5. Known quirks and deliberate choices

- **No proxies, no upgrades.** All five contracts are immutable. v1 ships
  this way deliberately to shrink audit scope. A bug that escapes the audit
  requires a full redeploy + migration, not a proxy upgrade.
- **Pauser has zero admin reach.** Only `setPaused`. Intentional — the hot
  key compromise model is "pause-grief only".
- **`slashJobStake` splits 50/50** between poster and treasury
  (via `recordOutflow`). Not parameterized.
- **Single verifier per job**, verifier chosen by `TreasuryPolicy.verifiers`
  allowlist, not per-job assignment. Multi-verifier consensus is out of scope.
- **Dispute window is 1 day** (`EscrowCore.DISPUTE_WINDOW`). Constant, not
  per-job.
- **`IERC20Like` vs full ERC20.** We never call `approve`/`allowance`
  on-chain (the deposit flow expects the EOA to pre-approve). SafeTransfer
  handles tokens that don't return a bool (USDT-style) and tokens that
  return false on failure. We do NOT support:
  - Rebasing tokens (balance drift breaks accounting).
  - Fee-on-transfer tokens (actual received < stated amount).
  - ERC777 / callback tokens with reentrancy hooks (guarded, but
    deliberately not on the approved-asset list).
- **No timelock on admin ops**. Multisig is the only governance layer for
  v1. Auditors may flag this — it's a deliberate trade-off for simplicity;
  timelock is on the v2 roadmap.
- **Claim TTL is per-job** (`claimTtls[jobId]`), set at creation time.
  Claim timeout reopens the job for re-claim after stake slash.
- **State-store fallback**. The off-chain layer refuses to boot in
  production without Redis (see [state-store.js](../mcp-server/src/core/state-store.js)).
  Auditors reviewing the auth flow should be aware that `AUTH_JWT_SECRETS`
  also gates all write-path endpoints via JWT verification.

---

## 6. Deployment parameters

Current testnet values (reproducible via [deploy_contracts.sh](../scripts/deploy_contracts.sh)):

| Parameter | Default | Notes |
|---|---|---|
| `dailyOutflowCap` | `1e24` wei | Very loose. Should tighten on mainnet. |
| `perAccountBorrowCap` | `1e21` wei | Per-wallet cap. |
| `minimumCollateralRatioBps` | `15000` (150%) | Liquidation floor. |
| `defaultClaimStakeBps` | `500` (5%) | Fraction of reward locked as stake. |
| `rejectionSkillPenalty` | `10` | Applied on terminal rejection. |
| `rejectionReliabilityPenalty` | `20` | |
| `disputeLossSkillPenalty` | `30` | Applied when arbitrator sides against worker. |
| `disputeLossReliabilityPenalty` | `50` | |
| `MAX_MILESTONES` | `32` | Constant in `EscrowCore`. |
| `DISPUTE_WINDOW` | `1 days` | Constant in `EscrowCore`. |

---

## 7. How to run the tests

Auditors should be able to reproduce every test green from a clean clone:

```bash
git clone <repo>
cd <repo>

# Solidity tests
forge test -vv

# Node integration tests
cd mcp-server
npm install
npm test

# Optional subprocess smoke tests (spins up real HTTP server)
RUN_HTTP_SMOKE=1 npm test
```

Expected counts at the time this doc was last updated:

- Foundry: **22** tests (10 core + 12 hardening).
- Node: **60** tests (auth, rate-limit, state-store, http-config, logger, metrics, event-bus).
- HTTP smoke (opt-in): **6** tests.
- Frontend (node --test on escape helpers + config): **13** tests.

---

## 8. Deliverables requested from the audit

1. Written report with severity-ranked findings (Critical / High / Medium /
   Low / Informational).
2. Proof-of-concept exploits for any Critical or High findings, expressed
   as Foundry tests against [test/AgentPlatform.t.sol](../test/AgentPlatform.t.sol)
   style harness.
3. Recommendations split into:
   - Must-fix before mainnet
   - Should-fix within N weeks
   - Nice-to-have / v2 roadmap
4. Sign-off statement once Critical + High items are resolved, for public
   posting alongside the mainnet announcement.

---

## 9. Contact

- Primary: <TBD — fill in before sending>
- Escalation: <TBD>
- Response SLA: within 2 business days for questions during audit; within
  1 business day for findings classified Critical.
