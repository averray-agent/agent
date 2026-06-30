# Launch Critical Path — Mainnet

**Scope:** the *sequencing + ownership* view of reaching mainnet real-funds launch — what
the long pole is, what parallelizes, who does what. This is the index that **orders** the
detailed runbooks; it does not duplicate them:

- Credential / infra / on-chain deploy detail → [`MAINNET_CREDENTIALS_PLAN.md`](./MAINNET_CREDENTIALS_PLAN.md) (20-step runbook + decisions)
- Product / positioning readiness → [`PHASE1_LAUNCH_PLAN.md`](./PHASE1_LAUNCH_PLAN.md)
- Audit findings / remediation → [`AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md)

---

## The one gate

**The external audit is the long pole — its lead time *is* the launch date.** Real funds do
not ship without it. Everything else parallelizes around it; the on-chain deploy itself is
~1 day of scripted work once the audit clears.

## Now — the levers that compress the timeline

| # | Action | Owner | Why it's critical-path |
|---|--------|-------|------------------------|
| 1 | **Book the audit firm**; freeze audited artifacts (`prepare-mainnet-audit-freeze.mjs`) | Pascal | Scheduling lead time is the bottleneck — book before anything else. |
| 2 | **Resolve MAIN-006** before the freeze (see below) | Codex | Known double-debit ships at v1; must not be in the audited build. |
| 3 | **Make the 5 open decisions** (`MAINNET_CREDENTIALS_PLAN` §5.2) | Pascal | Calls, not work — they unblock the parallel tracks. |
| 4 | **Order / enroll hardware**: 3 multisig signers + Ledger + YubiKeys ×6 | Pascal | Procurement lead time; fully parallel to the audit. |

## Parallel track — while the audit runs (zero audit dependency)

- **Multisig ceremony** — 3 hardware signers → `pallet_revive.map_account()` → owner record (`prepare-multisig-owner-record.mjs`). *[Pascal + signers]*
- **KMS multi-region** keys — ⚠ set at creation, **irreversible** — + **Roles Anywhere** CA + 2 profiles + VPS client certs. *[Pascal / infra]*
- **1Password mainnet vault tier** + SA tokens (incl. a read+write SA *if* the JWT refresh-flow automation is brought into mainnet scope). *[Pascal]*
- **Build the GAP scripts** (don't exist yet): mainnet backend env profile *[Claude]*, vault/token bootstrap *[Claude]*, `deployments/mainnet.json` + `mainnet-multisig-owner.json` *[Codex / ceremony]*.

## Deploy sprint — after the audit passes (~1 day, scripted)

1. Deploy 5 contracts with a **burnable deployer** key (`OWNER` = mapped multisig).
2. `transferOwnership(multisig)` as the deployer's last act → verify deployer holds zero roles → burn the key.
3. Role ceremonies (each a 2-of-3 `asMulti` two-leg): `setVerifier` **+** `setServiceOperator` (both), `setServiceOperator(escrowCore)`, `setArbitrator`, `setPauser`.
4. `audit-launch-readiness.mjs` green → render mainnet env → 3 closing proofs (env-secrets, usdc-config, smoke <24h).
5. Fund the signer with real low-value USDC → **≥3 live** claim→submit→verify→settle loops → **LIVE**.

### D-03 — deploy/backend contract-surface freeze

Normal production deploys update containers only; they do **not** deploy or rewire smart
contracts. The 2026-06-30 Hosted Worker Canary regression showed why this matters:
backend/ABI settlement code can roll forward while testnet contracts remain pinned, leaving
the brokered claim/submit/settle path red even though `/health` is green.

`deploy-production.sh` now fails closed when a deploy range changes contract/settlement
surface files (`contracts/`, `mcp-server/src/blockchain/`, or escrow redeploy tooling) without
also changing the active deployment manifest (`deployments/testnet.json` by default). To
proceed intentionally, first deploy/rewire contracts and commit the updated manifest, or use
the manual workflow-dispatch override `allow_contract_surface_drift=1` only after recording an
operator compatibility rationale. Automatic CI-triggered deploys keep the override disabled.

---

## MAIN-006 — `sendToAgentFor` operator-relay (double-debit **+ Critical operator-drain**) · owner: Codex

`payments:send` ships at v1 (in `BASE_CAPABILITIES`), and `POST /payments/send` can
**double-debit on a retry** after a lost local write — `AgentAccountCore.sendToAgentFor`
has no on-chain idempotency. Clear it **before** the freeze.

**⚠ Escalated by the 2026-06-25 pre-audit contract review (Critical).** The same
`sendToAgentFor` primitive has a *second*, worse weakness: it is gated only by `onlyOperator`
(`AgentAccountCore.sol:630`) with **no per-user authorization**, so a **compromised backend/KMS
serviceOperator can move *any* user's liquid balance** to an attacker-controlled recipient, who
then withdraws normally. This is an on-chain operator-key issue — **option (A)'s HTTP-route
defer does NOT mitigate it** — so the contract fix is now a hard mainnet requirement, not a
deferrable feature. Two options:

**(A) Defer the feature — fastest, recommended for v1.** Gate the route off until (B) lands.
The clean, *certain* place is a guard at the handler entry — **not** capability surgery:
- In `payment-routes.js` `handlePaymentRoute`, immediately after the `pathname !== "/payments/send"` early-return, short-circuit to a `503 { reason: "payments_send_disabled" }` when a `paymentsSendEnabled` flag is off (use the module's standard response helper).
- Wire `paymentsSendEnabled` from env (**default false**) into `createPaymentRoutes`; add a disabled-path test.
- ⚠ Do **not** cut by removing `payments:send` from `BASE_CAPABILITIES` alone — enforcement is spread across `capabilities.js`, `http-helpers.js`, the route-rule table, and `listAllKnownCapabilities` (multiple consumers + tests), so that risks an *incomplete* cut on the money path.

**(B) Fix it — now required for mainnet, not optional.** Make `sendToAgentFor` verify a
per-user **EIP-712 authorization** (the operator relays a user-signed intent carrying `nonce`
+ `deadline`). One change closes both weaknesses: the signature is the missing **authorization**
(kills the operator-drain Critical), the nonce is the missing **idempotency** (kills the
double-debit), and the meta-transaction shape **preserves the brokered / gas-sponsored model**
(the operator still relays and pays gas — it just can't move funds without the user's
signature). Contract change → must be in the frozen artifact.

**Status:** PR #688 implements (B) with an EIP-712 `SendToAgent` authorization signed by
`from` plus a per-`(from, nonce)` replay guard. Live chain use still requires the updated
contract artifact to be deployed and payment clients to sign the EIP-712 `SendToAgent`
payload before calling `/payments/send`.

**Recommendation:** ship **(A)** (defer `payments/send`) *and* **(B)** for mainnet — (A) alone
leaves the operator-drain Critical open. (A) is the quick HTTP cut; (B) is the contract fix the
audit will require regardless.

## Pre-audit contract findings — feed the external audit (2026-06-25) · owner: Codex

A deep contract-level agent review (full-source pass) on current `main`. Headline: the core
escrow lifecycle is **materially stronger** — the "generic operator can settle reserves" class
is closed (`escrowOperators` + ledger-level `settlementExecuted` + tests). Confirmed-secure:
0.8.24 overflow checks, non-reentrant settlement, escrow + ledger idempotency, milestone cap,
owner-gated mutations, and the mainnet deploy script refusing to enable XCM vDOT before
observer evidence.

**None of these are exploitable on the closed testnet beta** (test USDC, trusted testers,
uncompromised signer) — they are mainnet / real-funds gates. All contract fixes are Codex-owned
and must land in the audited artifact.

| Sev | Finding | Disposition |
|-----|---------|-------------|
| **Critical** | `sendToAgentFor` operator-relay, no per-user auth → compromised operator moves any user's liquid | **= MAIN-006 primitive** (above). Fix = EIP-712 per-user auth. Hard mainnet blocker. |
| **High** | Debt-gate asymmetry: `withdraw` checks `liquid >= amount + debtOutstanding`, but `_sendToAgent` / async-strategy paths only check `liquid >= amount` → debt-backed credit becomes withdrawable via transfer | Enforce withdrawable = `liquid - debtOutstanding` on `sendToAgent` / `sendToAgentFor` + strategy paths. Bounded by `BORROW_CAP`; sybils multiply it. |
| **High** | XCM `finalizeRequest` is operator-oracle (terminal status + amounts from owner/operator, no remote proof) | **Already tracked / staged** — XCM vDOT stays disabled for mainnet until native observer correlation is live. Confirmed, not new. The deploy script now fails this in no-broadcast preflight when `PROFILE=mainnet` and `WITH_XCM_VDOT_ADAPTER=1`. |
| **Med** | Onboarding claim-waiver enables sybil claim-griefing (free claim → no submit → timeout → repeat with fresh wallets) | Hardened in code: EscrowCore only applies the per-worker onboarding waiver when the job is explicitly marked `onboardingWaiverEligible`; backend previews and `ensureJob` now preserve that explicit curated-job flag. Closed-beta bundle/canary jobs are marked; public/open jobs default to paid claim locks. |
| **Med** | `reserveForRecurringTemplate` has no cancellation/refund path → misconfigured/retired templates strand funds | Covered by `cancelRecurringTemplateReserve`: refunds unused template reserve to liquid, emits cancellation event, and keeps template + aggregate reserved accounting synchronized. Not used in the beta. |
| **Med** | Open prod dep advisories | `ws` via `ethers`/`viem` remediated with controlled chain-lib bumps plus a root `ws@8.21.0` override; Ponder-transitive `@hono/node-server` pinned to `1.19.14`. Remaining: `drizzle`/`kysely` = **H3** (partially fixed, #686; residual inside Ponder), plus `vite` (frontend/Ponder transitive advisories). |
| **Low** | `_refreshStrategyAllocated` loops all registered strategies → owner-controlled OOG / config DoS | Covered by touched-strategy accounting: cache each strategy's contribution and resync only the strategy whose shares changed. Requires contract deployment with the frozen artifact. |
| **Low** | External-schema sig lacks low-s + chainId/address domain separation | Addressed in `codex/external-schema-eip712`: EIP-712 typed data is bound to `chainId` + `address(this)`, and low-s signatures are rejected. Requires the hardened EscrowCore artifact to be deployed before mainnet. |

## Explicitly NOT blocking v1

- **JWT TTL ≤1h automation** — deferred to mainnet prep (refresh-flow build; see the JWT callout in `MAINNET_CREDENTIALS_PLAN`). Testnet stays on the 30d hand-minted `admin-jwt`.
- **MAIN-005** — display-unit rounding in `resolveRemainingPayout`; LOW, deferred.

## Security-review hardening — mainnet prep (from external-agent review)

Two independent reviewer agents (onboarding to the closed beta) read the published threat
model and probed the live surface. Most findings were already-documented or by-design; the
live checks confirmed `/metrics` is bearer-gated (401) and the JWT alg is ES256 (manifest
fixed, #682). These three are the concrete hardening items worth tracking — **none block the
testnet beta** (testnet financial risk ≈ 0); all are mainnet-prep.

| # | Item | Owner | Notes |
|---|------|-------|-------|
| H1 | **Deploy-time guard for `JWT_KMS_CREDENTIAL_CHECK_SKIP`** | Claude | The emergency boot-cred-check bypass has no guard against accidental ship. Add a CI/deploy assertion that it's unset in the rendered production env (fail closed). |
| H2 | **Move `DISCOVERY_PUBLISHER_PRIVATE_KEY` off GitHub Secrets → KMS** | Pascal / infra | The last raw signer key not on KMS; signs discovery-manifest hashes (not funds), and the on-chain `DiscoveryRegistry` hash-check bounds the blast radius today. Migrate before mainnet. |
| H3 | **Known-vuln deps: `drizzle-orm` + `kysely` SQLi** | Codex | Partially remediated 2026-06-25: the direct indexer `drizzle-orm <0.45.2` dependency was removed and XCM outcome code now consumes Ponder's Drizzle re-export, avoiding a broken mixed-Drizzle runtime. Residual risk remains inside `ponder@0.16.6`, which is still latest and still vendors vulnerable Drizzle/Kysely. Track upstream Ponder or ship only a separately rehearsed override. |

### H3 detail — indexer ORM SQLi advisories

**Status as of 2026-06-25:** partially remediated. The indexer's direct
`drizzle-orm` dependency is removed and Averray-owned XCM outcome queries now
use Ponder's Drizzle re-export, avoiding a broken mixed-Drizzle runtime while
closing the direct dependency exposure in `indexer/package.json`. The XCM
outcome publisher has a regression test proving external outcome values remain
parameterized through the SQL template.

Residual risk remains in `ponder@0.16.6`, which is still the latest Ponder
release and still vendors `drizzle-orm@0.41.0` plus `kysely@0.26.3`. Do not
force an override into Ponder without a dedicated live-ingest rehearsal; that
could break Ponder's runtime query layer while giving a false sense of security.

Close criteria:

- [x] Direct indexer `drizzle-orm <0.45.2` dependency is removed.
- [x] `npm --workspace indexer run typecheck` and
  `npm --workspace indexer run test:api` pass with XCM queries using Ponder's
  Drizzle re-export.
- [ ] Ponder releases a compatible version that removes its vulnerable
  transitive `drizzle-orm` / `kysely` copies, or Averray validates and ships a
  deliberately tested override with live ingest evidence.

## Honest timeline

Audit (weeks) and hardware/multisig (weeks) run **in parallel** — not days. There is no
version where an external auditor and a hardware signing ceremony happen overnight. The only
real levers: (1) start the audit **and** hardware procurement *today*; (2) keep
`/payments/send` out of live scope unless the signed MAIN-006 artifact is deployed;
(3) pre-script and rehearse the deploy sprint so it's a one-day
operation the moment the audit clears.
