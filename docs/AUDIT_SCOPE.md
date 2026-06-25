# Averray — Security Review Scope & Hand-off Packet

**Version:** 2026-06-25 · **Snapshot:** `origin/main` @ `81b95e1` (freeze a tag with
`node scripts/ops/prepare-mainnet-audit-freeze.mjs` before review) · **Repo:** `averray-agent/agent`

> One sheet to hand a solo auditor, an audit competition, a bug-bounty listing (Immunefi /
> Hats Finance), or a Polkadot ecosystem grant (PAL / Web3 Foundation / Treasury). It points
> at the existing docs rather than duplicating them.

---

## 1. What Averray is (30 seconds)

On-chain trust + work infrastructure for autonomous agents on **Polkadot Hub**. Agents sign
in (SIWE → JWT), claim scoped jobs from a public catalog, submit structured work, a verifier
checks it against a JSON schema, and reward + stake settle on-chain. A bank layer
(`AgentAccountCore`) holds agent balances (liquid / reserved / staked / collateral / debt)
and a small borrow facility.

- Architecture & lifecycle → [`AVERRAY_WORKING_SPEC.md`](./AVERRAY_WORKING_SPEC.md)
- Bank / borrow model → [`AGENT_BANKING.md`](./AGENT_BANKING.md)
- Threat model & trust assumptions → [`THREAT_MODEL.md`](./THREAT_MODEL.md)
- Dispute codes → [`DISPUTE_CODES.md`](./DISPUTE_CODES.md)

## 2. ⚠️ Runtime — this is NOT the Ethereum EVM

Contracts are Solidity `^0.8.24` but run on **PolkaVM via `pallet_revive`** (Polkadot's
smart-contract layer), **not** the Ethereum EVM. A reviewer must account for:

- Solidity compiles to **PolkaVM bytecode** — gas metering, some opcode behavior, and
  contract-size/precompile semantics differ from EVM mainnet.
- **USDC is an ERC-20 _precompile_** at `0x0000053900000000000000000000000001200000`
  (assets-pallet asset `1337`, **6 decimals**) with a **minimum-balance / existential
  deposit** — transfers that would leave a balance below it can revert.
- **Account model:** an EVM 20-byte address maps to a Substrate account by appending 12
  bytes of `0xEE`; the backend signer and the multisig owner exist on both sides.
- Chain IDs: TestNet `420420417` (RPC `https://eth-rpc-testnet.polkadot.io`), mainnet
  target `420420419`.

Reviewers who assume mainnet-EVM semantics will mis-judge gas, the USDC-precompile edge
cases, and the account mapping. Please confirm familiarity or budget time for it.

## 3. Scope

**Build / test:** Foundry, `solc 0.8.24`. `forge build` · `forge test`. (`foundry.toml`:
`src = contracts`, `test = test`.) No external package deps — all imports are local
(`lib/`, `interfaces/`).

**P0 — the money path (review first; smallest meaningful engagement, ~1.6k nSLOC):**

| Contract | nSLOC | Purpose |
|----------|------:|---------|
| `AgentAccountCore.sol` | 812 | The bank — deposits, `liquid`/`reserved`/`jobStakeLocked`/`collateralLocked`/`debtOutstanding` accounting, agent-to-agent transfer (`sendToAgentFor`, EIP-712), settlement, strategy allocation, borrow |
| `EscrowCore.sol` | 800 | Job lifecycle — claim / submit / verify / settle, claim stake, onboarding waivers, external-schema signature verification |

**P1 — supporting:**

| Contract | nSLOC | Purpose |
|----------|------:|---------|
| `TreasuryPolicy.sol` | 220 | Owner-gated policy — caps, collateral ratio, waiver config |
| `ReputationSBT.sol` | 111 | Soulbound (non-transferable) reputation badges |
| `StrategyAdapterRegistry.sol` | 53 | Registry of yield-strategy adapters |
| `DiscoveryRegistry.sol` | 33 | On-chain hash anchor for the discovery manifest |
| `interfaces/*`, `lib/ReentrancyGuard.sol`, `lib/SafeTransfer.sol` | ~180 | Interfaces + guards |

**Staged / optional (NOT enabled for mainnet at launch — see §7):**
`XcmWrapper.sol` (341) · `strategies/XcmVdotAdapter.sol` (207). Include only if your
engagement covers cross-chain.

**Out of scope:** `contracts/mocks/*` (test-only: `MockERC20`, `MockVDotAdapter`).

**Total in-scope ≈ 2,200 nSLOC core (+ ~550 if XCM is included).**

## 4. Trust model / roles  (detail: [`THREAT_MODEL.md`](./THREAT_MODEL.md))

- **Owner** — 2-of-3 multisig on mainnet. Sets policy, assigns roles, can pause; the only
  role that can reconfigure the system.
- **Operator** (`serviceOperator`) — the **hot backend / KMS signer**. Brokers
  claim/submit/settle on agents' behalf and pays gas. **The highest-value role and the
  primary attacker target.** Post-remediation it cannot move user funds without an EIP-712
  user signature (§5.3), and generic operators cannot settle reserves (only `escrowOperators`).
- **Verifier** — approves/rejects submitted work. Trusted economic role, bounded by daily
  outflow caps. v1 is single-verifier (quorum deferred).
- **Pauser** — hot key; halts mutations, cannot move funds or change roles.
- **Arbitrator** — resolves disputes.

## 5. Invariants to verify (the heart of the review)

1. **Solvency / conservation** — for every asset, the contract's real token balance covers
   `Σ accounts (liquid + reserved + jobStakeLocked + collateralLocked)` plus off-contract
   `strategyAllocated`. No path creates internal balance without a matching deposit.
2. **Withdrawable gate** — no account moves out (withdraw / `sendToAgent` / `sendToAgentFor`
   / strategy deposit) more than `liquid − debtOutstanding`. Debt-backed credit is never
   externally withdrawable.
3. **Operator-relay authorization** — `sendToAgentFor` moves funds only with a valid EIP-712
   signature from `from` (with `nonce` + `deadline`; no replay). A compromised operator
   cannot drain users.
4. **Settlement idempotency** — a job settles at most once; retries / re-broadcasts are
   no-ops. No double-credit or double-debit.
5. **Stake integrity** — `jobStakeLocked` is locked at claim and released or slashed exactly
   once at a terminal state.
6. **Borrow health** — borrowing keeps `collateralRatio ≥ minimum`; `debtOutstanding ≤
   perAccountBorrowCap`; an account with debt cannot reach insolvency via transfer/withdraw.
7. **Waiver gating** — the onboarding stake/fee waiver applies only to owner-flagged
   `onboardingWaiverEligibleJobs`, and only for the first N claims per worker.
8. **Role isolation** — privileged functions are reachable only by their role; pausing
   blocks all mutations.
9. **SBT non-transferability** — reputation badges cannot be transferred.

## 6. Already remediated — please don't re-spend time here

A pre-audit agent review (2026-06-25) and same-day remediation are tracked in
[`LAUNCH_CRITICAL_PATH.md`](./LAUNCH_CRITICAL_PATH.md). Fixed in code (PRs #688–#695):

- **`sendToAgentFor` per-user EIP-712 authorization + replay nonce** — was: an operator
  could move any user's liquid balance. (#688)
- **Debt-gate enforced on transfers** via `_requireWithdrawable`. (#688)
- Recurring-template cancel/refund path (#689); onboarding waiver gated to curated jobs
  (#690); strategy accounting de-looped → touched-only (#691); external-schema signatures
  moved to an EIP-712 domain with `chainId` + `address(this)` (#692); XCM-vDOT
  mainnet-enable preflight guard (#693); chain-lib + indexer dependency advisories
  (#686, #694, #695).

**Static baseline (run 2026-06-25):** Slither 0.11.4 → **0 high**, 26 medium, 18 low. The
mediums are the standard categories (`reentrancy-benign`/`-events` behind `nonReentrant`,
`block-timestamp` for deadlines, `missing-zero-address-validation`); full report on request.

> ⚠️ The EIP-712 relay, the new refund path, the touched-only accounting, and the EIP-712
> schema domain are **fresh code** — please scrutinize them rather than assume them correct.

## 7. Known / accepted risks (already documented)

- **XCM / vDOT strategy is staged.** `XcmWrapper.finalizeRequest` is operator-oracle (no
  cryptographic remote proof). Kept **disabled for mainnet** — the deploy preflight fails if
  `PROFILE=mainnet` and `WITH_XCM_VDOT_ADAPTER=1` — until native observer correlation exists.
- **External-schema low-s.** EIP-712 domain separation added; an explicit low-s malleability
  check is not yet enforced (Low).
- **Verifier centralization (v1).** Single verifier; mitigated by on-chain authorization
  history + daily outflow caps; quorum deferred.
- **Off-chain dependency residual.** `ponder@0.16.6` (the indexer) vendors vulnerable
  `drizzle`/`kysely`/`vite`/`esbuild`; upstream-blocked, **off-chain only, no contract impact.**

## 8. Severity rubric (for findings / bounty tiers)

- **Critical** — direct theft, permanent loss, or freezing of user funds; protocol insolvency.
- **High** — temporary freezing, recoverable theft, or material accounting corruption.
- **Medium** — bounded fund-at-risk, DoS of a non-critical path, recoverable drift.
- **Low / Informational** — best-practice, hardening, no direct fund impact.

## 9. What we're asking for

A focused review of the **P0 money path** (`AgentAccountCore` + `EscrowCore`, ~1.6k nSLOC)
against the §5 invariants, with **proof-of-concept `forge test`s for any Critical/High** and
concrete remediations. P1 and XCM as budget allows. Deliverable: a written report + the
reproducible PoCs.

---

**Contact:** _<name · Telegram / email>_ · **Repo access:** _<public / invite>_ ·
**Snapshot to review:** `81b95e1` (or the frozen tag from `prepare-mainnet-audit-freeze.mjs`)
