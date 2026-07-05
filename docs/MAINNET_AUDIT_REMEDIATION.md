# Mainnet Audit Remediation — solo-auditor report (2026-06-30)

**Verdict: Conditional mainnet approval — address all 7 High findings before deployment.**
`0 Critical · 7 High · 12 Medium · 14 Low · 18 Informational`. Overall risk: MEDIUM-HIGH.
The core escrow/settlement logic was rated *"well-designed with strong idempotency
guarantees."* This board tracks every actionable finding to closure; it is the coordination
contract — only edit your own rows.

> **⚠ SECOND CONTRACT AUDIT (2026-07-02) — contract findings are now tracked in [`MAINNET_AUDIT_2_REMEDIATION.md`](MAINNET_AUDIT_2_REMEDIATION.md).** A deeper adversarial multi-agent contract audit (0 Critical · 2 High · 8 Medium · 15 Low · 5 Info), independently code-verified, supersedes/confirms the contract rows here. **Critically, audit-2 H-1 supersedes C-01:** the daily-outflow circuit-breaker meters internal book-transfers, not real withdrawals, so "set a finite `dailyOutflowCap`" is **not** a valid mitigation and must be re-implemented *before* it is armed. Reconciled contract items: C-01→H-1(+L-1 defaults), C-02→H-2, C-03→L-2, C-18→L-3, C-13→M-6, C-17→M-2, C-09→L-5. All Claude-owned items on this board are merged (#711–#715).

**Auditor-verified strengths (no action):** settlement idempotency *("among the best
reviewed")*, KMS/EIP-2 signing *("exemplary")*, SafeTransfer (USDT-style + standard ERC20),
session state machine, idempotent-mutation framework, SIWE/EIP-4361, **debt-gate fix
(#688) verified PASS-remediated**. 13/14 critical invariants PASS (the 14th is the H-01
default-config warning).

## High (7) — must fix before mainnet (the approval condition)

| ID | Finding | Location | Owner | Status |
|----|---------|----------|-------|--------|
| **C-01** | Daily outflow cap defaults to `type(uint256).max` — no on-chain protection | `TreasuryPolicy.sol` ctor | Codex | ✅ remediated → **audit-2 H-1** (breaker re-implemented, #717/#718, merged); re-verify pending. ⛔ do **not** arm a finite cap until the split-role/cap-exempt slash follow-on lands |
| **C-02** | Slashed treasury portion recorded but never transferred → funds trapped in AAC | `AgentAccountCore.sol` `slashJobStake`/`slashClaimFee` | Codex | ✅ remediated → **audit-2 H-2** (owner-settable treasury sink, #718, merged); re-verify pending |
| **C-03** | AAC must be `serviceOperator` or **all slashing reverts** (silent deploy dependency) | `TreasuryPolicy.sol` `recordOutflow` | Codex | ✅ remediated → **audit-2 L-2** (role-split + deploy-finalization asserts `outflowRecorder(AAC)`, #724, merged); re-verify pending |
| **C-18** | `workerClaimCount` never decrements → workers permanently penalized for timeouts | `EscrowCore.sol` `handleClaimTimeout` | Codex | ⬜ **OPEN** → reclassified **audit-2 L-3** (severity downgraded High→Low); the underflow-guarded decrement in `handleClaimTimeout` is **not yet implemented** |
| **B-01** | Auto-verifier triggers settlement in-process, bypassing JWT auth | `submitted-job-auto-verifier.js` | Claude | ✅ **this PR** |
| **B-11** | Autonomous verdict ingestion has no auth | `verification-ingestion-service.js` | Claude | ✅ **this PR** |
| **D-01** | Long-lived 1Password service-account tokens (4) | `deploy/secrets-inventory.md`, `docs/SECRETS_CALENDAR.yml`, `scripts/ops/rotate-sa-token.mjs` | Pascal/infra | 🟢 SMOKE + CI re-rotated at **env scope** + repo shadows **deleted**, scope-verified 2026-06-30 ✓. Old tokens revoked + 7 duplicate service accounts pruned (13→6, one SA per role) 2026-06-30. Tails: confirm keepers survived the prune (next consuming run / canary 1P-load) · Events-API monitoring. |

## Medium (12) — should fix before mainnet

| ID | Finding | Owner | Status |
|----|---------|-------|--------|
| C-04 | `sendToAgent` lacks `nonReentrant` (defense-in-depth) | Codex | ☐ |
| C-05 | `recordOutflow` lacks `nonReentrant` | Codex | ☐ |
| C-09 | `XcmWrapper` async request ledger has no expiry | Codex | ☐ |
| C-12 | No upper bound on `minimumCollateralRatioBps` | Codex | ☐ |
| C-15 | Zero-reward jobs allowed → queue griefing (`require(reward > 0)`) | Codex | ☐ |
| B-02 | HS256 testnet JWT — add a mainnet `SIGNER_BACKEND=kms` startup assertion | Claude | ✅ **this PR** — `assertMainnetSignerPosture` fails boot closed on mainnet + local signer |
| B-03 | Grant cache 15s staleness on revocation (shorten for mutations) | Claude | ✅ **this PR** — mutating requests use a 2s grant-cache TTL (reads keep 15s), so a cross-process revoke stops authorizing state changes within ~2s |
| B-04 | X-Forwarded-For spoofing under `TRUST_PROXY` (Caddy must strip it) | Claude/infra | ✅ **this PR** — Caddy overwrites XFF with the real peer IP (`strip_forwarded_for` snippet on every `reverse_proxy`, `caddy validate` clean) and `extractClientKey` now keys on the rightmost (proxy-appended) hop, not the client-controlled leftmost — closes the per-IP auth rate-limit spoof |
| D-02 | Chain-ID mismatch risk — startup check configured vs RPC-reported | Claude/infra | ✅ **this PR** — `assertChainIdMatchesRpc` fails closed on a confirmed mismatch (warns if RPC unreachable) |
| D-03 | CI auto-deploy without manual gate | Pascal/infra → Codex | 🟢 #706 (ff670f4): contract-surface drift now **fails closed** on auto-deploys (the 2026-06-30 canary regression's root cause); override is dispatch-only `allow_contract_surface_drift=1`. A broad GitHub "required reviewers" human gate remains a separate optional hardening. |
| E-17 | **JS `Number` for off-chain USDC math** (systemic) → BigInt | Claude | ✅ **this PR** — the authoritative treasury/settlement/strategy accounting was already BigInt (the `*Raw` base-unit migration, #337→#618) and on-chain amounts are brokered as `uint256`; this closes the residual **projection-layer** Number math: `claim-economics.js` bps stake/fee and `estimateNetReward` now compute in integer base units at the asset's precision (matching the on-chain floor) and format back only for the Number return contract |

## Low (14) — fix opportunistically / post-launch

`C-06` per-contract ReentrancyGuard · `C-10` `finalizeXcm` permissionless · `C-13` pause
blocks slashing · `C-14` milestone spam within cap · `C-17` `autoResolveOnTimeout` favors
worker · `B-06` payment asset defaults to DOT · `B-12` verifier-result endpoint public ·
`E-10/E-18/E-21/E-24/E-26/E-27` economic edge cases · ~~`D-04` missing Caddyfile security
headers~~ → **✅ this PR**: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy` on every Caddy site (+ `-Server`), and a strict `default-src 'none'; frame-ancestors 'none'`
CSP on the JSON API + indexer sites (`caddy validate` clean).

## Autonomous-settlement trust model (documents B-01 / B-11)

The **auto-verifier** (`submitted-job-auto-verifier.js`) and **verification-ingestion**
(`verification-ingestion-service.js`) run as **trusted in-process schedulers**. They reach
`verifySubmission` (which brokers `resolveSinglePayout` on-chain) the same way the manual
`/verifier/run` route does — **with no JWT principal, by design** (you can't JWT-auth an
in-process caller).

- **Threat:** a process compromise could trigger autonomous settlement without auth.
- **Bounds (defense in depth):** `requireChainBackedMutation` (every mutation must reach a
  real on-chain action — no fake-settled state); the hard `{benchmark, deterministic}` mode
  allowlist (never `human_fallback` / `github_pr` / disputed); HALT-awareness; and idempotent
  settlement keys (`keccak256(jobId,index,amount)` + `settlementExecuted` → no double-pay).
- **Traceability (this PR):** every autonomous settlement + verdict ingestion is logged under
  the synthetic principal **`system:auto-verifier`** (`auto_verify.settlement_triggered`,
  `auto_verify.verified`, `verification_ingest.autonomous`) — so a compromise is auditable.
- **Residual:** documented + bounded, not eliminated. The additional lever is the existing
  `AUTO_VERIFY_ENABLED` config gate + the pauser kill switch.

## Path to mainnet

Fix the 7 High → (optionally) the 12 Medium → **re-verify the fixes with the same auditor**
→ ship **capped** (guarded-launch profile, `LAUNCH_CRITICAL_PATH.md`). No redesign required.
