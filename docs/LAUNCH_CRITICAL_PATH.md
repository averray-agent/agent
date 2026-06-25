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

---

## MAIN-006 — payments/send double-debit (gates the audit freeze) · owner: Codex

`payments:send` ships at v1 (in `BASE_CAPABILITIES`), and `POST /payments/send` can
**double-debit on a retry** after a lost local write — `AgentAccountCore.sendToAgentFor`
has no on-chain idempotency. Clear it **before** the freeze. Two options:

**(A) Defer the feature — fastest, recommended for v1.** Gate the route off until (B) lands.
The clean, *certain* place is a guard at the handler entry — **not** capability surgery:
- In `payment-routes.js` `handlePaymentRoute`, immediately after the `pathname !== "/payments/send"` early-return, short-circuit to a `503 { reason: "payments_send_disabled" }` when a `paymentsSendEnabled` flag is off (use the module's standard response helper).
- Wire `paymentsSendEnabled` from env (**default false**) into `createPaymentRoutes`; add a disabled-path test.
- ⚠ Do **not** cut by removing `payments:send` from `BASE_CAPABILITIES` alone — enforcement is spread across `capabilities.js`, `http-helpers.js`, the route-rule table, and `listAllKnownCapabilities` (multiple consumers + tests), so that risks an *incomplete* cut on the money path.

**(B) Fix it.** Add a per-`(from, key)` on-chain dedup mapping to `sendToAgentFor` (re-broadcast = no-op) plus a durable pre-send intent record. Contract change → must be in the frozen artifact.

**Recommendation:** (A) for v1 unless agent-to-agent transfer is day-1 essential; (B) post-launch.

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
| H3 | **Known-vuln deps: `drizzle-orm` + `kysely` SQLi** | Codex | `drizzle-orm <0.45.2` (GHSA-gpj5-g38j-94v9) + `kysely <=0.28.16` (3× SQLi). **Not a clean bump:** (a) direct `drizzle-orm ^0.41→^0.45.2` is breaking and touches settlement code (`indexer/src/api/xcm-outcome*.ts` import `sql`/`eq`/`and`) → Codex must verify against a live chain+DB; (b) `kysely` + ponder-nested `drizzle` are **transitive via `ponder@0.16.6`, already the latest** — unclearable by upgrade until ponder patches, or via a risky `overrides` force that may break ponder's runtime. Bounded today by the indexer SQL validator + testnet-only. Track upstream ponder; revisit before real funds. |

## Honest timeline

Audit (weeks) and hardware/multisig (weeks) run **in parallel** — not days. There is no
version where an external auditor and a hardware signing ceremony happen overnight. The only
real levers: (1) start the audit **and** hardware procurement *today*; (2) cut scope
(MAIN-006 option A); (3) pre-script and rehearse the deploy sprint so it's a one-day
operation the moment the audit clears.
