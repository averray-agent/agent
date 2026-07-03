# Threat Model

> Current roadmap/status source: [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md).
> This threat model remains the detailed risk and mitigation reference.

This document records the launch threat model for Averray's v1 control plane.
It is intentionally operational: each entry names the trust boundary, the
current mitigation, and the follow-up that would reduce the risk further.

## Scope

In scope:

- hosted API, operator app, indexer, and discovery manifest
- Hub TestNet contract control plane
- verifier, arbitrator, pauser, and owner roles
- funded-job receipts, disclosure windows, and recovery storage
- bootstrap job sourcing and upstream-status instrumentation

Out of scope:

- mainnet real-funds strategy operations before a separate mainnet launch review
- v2 arbitration quorum mechanics
- future Proof of Personhood integration before primary documentation exists

## Threats

### Verifier Key Compromise

Risk: a compromised verifier can approve or reject submissions dishonestly.

Current mitigation:

- verifier authorization is on-chain
- verifier authorization history includes `wasAuthorizedAt`, so later audits can
  identify which receipts were signed inside a compromised window
- high-value or subjective jobs remain out of v1 launch scope

Follow-up:

- publish a concrete verifier key-rotation cadence
- alert on verdict-volume and verdict-outcome anomalies
- require multiple verifiers for higher-value jobs in a later contract version

### Platform Signer Compromise

Risk: the signer that publishes discovery manifests or mutates platform-owned
configuration could publish stale or hostile metadata.

Current mitigation:

- `DiscoveryRegistry` stores the canonical manifest hash on-chain
- the GitHub workflow only publishes when the served manifest hash differs
- owner authority has moved toward the 2-of-3 multisig flow documented in
  [MULTISIG_SETUP.md](./MULTISIG_SETUP.md)
- backend **blockchain signer** is **KMS-backed** since the 2026-05-16
  Phase 3 cutover (`SIGNER_BACKEND=kms` in `deploy/backend.env.template`);
  the private key material lives only inside AWS KMS and is
  non-exportable. The backend only ever calls `kms:Sign`. See
  [`docs/SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md).
- backend **JWT signer** is also KMS-backed since the 2026-05-21 Phase
  4b Stage 2C-2 cutover (`JWT_BACKEND=kms`). Distinct KMS key
  (`ECC_NIST_P256`, signing-only role policy), distinct IAM principal
  (`averray-jwt-signer-testnet-role`), distinct alarm surface. A
  blockchain-signer key compromise cannot mint JWTs; a JWT-signer key
  compromise cannot move on-chain funds. See
  [`docs/PHASE_4B_KMS_JWT_PLAN.md`](./PHASE_4B_KMS_JWT_PLAN.md) §3.
- backend AWS credentials are provisioned via **IAM Roles Anywhere**
  (Phase 5a cutover 2026-05-21) — short-lived STS sessions (~1h TTL,
  `ASIA*`-prefixed) issued via `aws_signing_helper` from X.509 client
  certs on the VPS. The previously-rendered long-lived static IAM
  access keys (`AKIA*`) are no longer in `/run/agent-stack/backend.env`
  as of Stage 2C-3 (PR #463). 1Password retention for the static keys
  is ~30 days as rollback target, then deleted. See
  [`docs/PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md).

Follow-up:

- keep signer duties separated from hot operational wallets
- finish the recovery playbook dry run for lost-key scenarios
- require multisig review for any mainnet-adjacent owner mutation
- rotate the Roles Anywhere X.509 client certs every 90 days per the
  cadence in
  [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
  §"Cert TTL: 90 days, rotated on calendar". Expired certs mean the
  backend cannot mint new STS sessions and existing sessions degrade
  silently as their 1h TTL lapses.
- complete Phase 5a-retire (≥30 days after 2026-05-21 cutover): delete
  the static IAM access keys + their 1Password fields so the rollback
  target — and a potential leak vector — disappears.
- migrate the `DISCOVERY_PUBLISHER_PRIVATE_KEY` (still a raw private
  key in GitHub Secrets) to a KMS-backed signer, mirroring the Phase
  3 backend pattern. Practical risk is bounded — that key only
  publishes manifest hashes — but the asymmetry is worth closing once
  Phase 4c lands.

### Pauser Compromise

Risk: a compromised pauser can freeze the system.

Current mitigation:

- the pauser role only freezes or unfreezes; it cannot move funds
- recovery is an owner or multisig rotation of the pauser

Follow-up:

- rehearse pause and unpause from the pauser key
- add alerting around pause-state changes

### Disclosure Window Abuse

Risk: failed attempts remain private during the disclosure window, which could
hide low-quality behavior for too long.

Current mitigation:

- on-chain lifecycle events still count the failure path
- delayed content visibility is resolved at read time, not by mutating records
- recovery storage is append-only and content-addressed

Follow-up:

- expose aggregate delayed-disclosure counts without revealing protected content
- run a periodic disclosure-window audit before launch claims

### Maintainer-Side Reputation Poisoning

Risk: a hostile or overloaded upstream maintainer can mass-close jobs and
damage worker reputation unfairly.

Current mitigation:

- repository caps bound exposure to any single maintainer surface
- denylist policy removes unsuitable repos
- week-12 reporting focuses on upstream merge rate rather than raw claim volume

Follow-up:

- monitor close reasons weekly
- keep security, standards, and hostile-maintainer surfaces denylisted by default

### Native XCM Observer Correlation Gap

Risk: async XCM settlement could be credited to the wrong request if return-leg
correlation is ambiguous.

Current mitigation:

- HTTP allocation routes accept intent, not raw caller-provided XCM bytes
- backend-generated messages append `SetTopic(requestId)`
- `XcmWrapper.queueRequest` validates SetTopic on queued payloads

Follow-up:

- run the Chopsticks/Bifrost preservation experiment
- if SetTopic is not preserved, choose and document the serialized-lane or
  amount-perturbation fallback before production-volume strategies

### Async XCM Input Surface

Risk: if callers could submit arbitrary XCM bytes, the wrapper would queue
messages outside platform policy.

Current mitigation:

- the live HTTP API is intent-based for allocate/deallocate
- backend policy assembles the message
- admin-only observation/finalization routes are idempotency guarded

Follow-up:

- keep raw-byte XCM interfaces out of public routes
- expand canonical request-hash receipts to every future settlement mutation

### USDC Issuer Dependency

Risk: v1 USDC escrow inherits issuer and regulatory risks, including freeze
events, depeg events, and blacklisting.

Current mitigation:

- launch parameters are explicit about USDC asset address and decimals
- supported assets metadata is published through the platform discovery surface
- USDC is treated as a v1 settlement choice, not a platform token

Follow-up:

- review legal and operational exposure before meaningful mainnet volume
- keep multi-asset settlement as a later mitigation

### Account Overlay Staleness or Durability Loss

Risk: the per-wallet overlay state the operator UI relies on (treasury timeline,
last strategy activity, pending XCM breadcrumbs) lives in process memory. A
restart loses it; a stale cache can also mask a fresher chain read if the
overlay-vs-live precedence is wrong.

Current mitigation:

- every overlay field is classified as `chain_authoritative`, `derived_cache`,
  or `display_only` (see `ACCOUNT_OVERLAY_CLASSIFICATION` in
  [`mcp-server/src/core/account-mutation-service.js`](../mcp-server/src/core/account-mutation-service.js))
- `attachStoredTreasuryMetadata` resolves merges with live wins per-key for
  chain-backed fields; stored is gap-fill only
- the `AccountOverlayStore` writes through to the Redis-backed state-store so
  overlay state survives process restart; bootstrap hydrates the cache before
  the HTTP server accepts requests
- restart simulation is locked by an integration test:
  `account-overlay-store.test.js — restart simulation`

Follow-up:

- expose `_meta.fieldSources` on account API responses so external integrators
  see the classification without reading the source
- migrate `display_only` fields with load-bearing operator value (treasury
  timeline) to Postgres if Redis-persistence guarantees become insufficient
- add a multi-process cache-invalidation pub/sub channel once any deploy runs
  more than one backend replica against the same Redis state-store

### Public Read-Surface Leakage

Risk: data and metadata endpoints exposed without auth on `index.averray.com`
and `api.averray.com` can leak request-path histograms, schema, operational
signals, and (in worst case) be used as an SQL-injection vector against
indexer transitive deps.

Current mitigation:

- `/sql/*` direct SQL relay has been removed from the indexer
  ([`indexer/src/api/index.ts`](../indexer/src/api/index.ts)); the only
  remaining public read paths are `/graphql`, `/xcm/outcomes`, `/health`,
  `/ready`, and `/status`
- `/graphql` accepts an optional `GRAPHQL_BEARER_TOKEN` Bearer gate; when the
  env is unset a loud startup warning records that the route is intentionally
  public
- `/metrics` on `api.averray.com` is bearer-gated in production by
  `METRICS_BEARER_TOKEN`; if production is configured to require metrics auth
  and no token is present, the route fails closed instead of serving metrics.
  The env vars are documented in
  [`deploy/backend.env.template`](../deploy/backend.env.template)
- Ponder's SQL validator rejects schema-qualified queries
  (`information_schema.tables`) and function calls (`current_user`,
  `version()`), bounding the readable surface to the on-chain-derived
  `onchainTable` set even on `/graphql`

Follow-up:

- set `GRAPHQL_BEARER_TOKEN` and `METRICS_BEARER_TOKEN` in production env and
  rotate the operator app to send the bearer
- bump Ponder's transitive `kysely` and `drizzle-orm` to versions without
  open SQL-injection advisories (npm audit currently reports 3 high
  severity on these transitive deps)
- consider migrating `/graphql` behind the same Caddy basic-auth layer the
  operator app uses for `app.averray.com`, so the gate is enforced at the
  perimeter rather than inside the indexer

### Authentication Token Exposure

Risk: browser JWTs or API keys copied into chat, logs, or issue comments can be
used until expiry or revocation. A leaked HMAC secret would let an attacker
forge tokens for any subject; a leaked asymmetric public key cannot mint
tokens.

Current mitigation:

- production auth is strict SIWE JWT — every issued token has a finite
  TTL, a `kid`-bound issuer, and an explicit audience claim
- since the 2026-05-21 Phase 4b Stage 2C-2 cutover, the backend's
  dispatcher runs `JWT_BACKEND=kms` — verifier **refuses HS256** and
  accepts only ES256 signed against the KMS JWT key (`kid=jwt-1`,
  `ECC_NIST_P256`). A leaked HMAC secret can no longer mint accepted
  tokens; the only mint path is `kms:Sign` against the JWT key, which
  is restricted to the `averray-jwt-signer-*-role` IAM role
- tokens carry a `roles: [...]` array claim (multi-role); the verifier
  matches against `JWT_EXPECTED_ROLES` and rejects unknown roles —
  preventing privilege escalation via a leaked operator token to a
  capability the original subject wasn't granted
- boot-time `kms:GetPublicKey` against the JWT key validates the
  credential chain at every container start
  (`jwt-kms-credential-check.ok` log line); misconfiguration is loud
  (`bootstrap.init_failed`) rather than silent
- secrets are stored in 1Password (`prod-backend`, `prod-smoke`,
  `prod-ci`, `prod-indexer` vaults; service-account-scoped tokens) and
  in GitHub Actions secrets — not committed to the repo
- refresh tokens follow RFC 9700 strict-replay semantics — a stolen
  refresh token rotates on first use, invalidating both the stolen
  and the legitimate copy and surfacing the theft in audit logs

Follow-up:

- rotate any API key or token pasted into shared chat (still applies —
  the asymmetric move closes the forgery vector but not the
  use-until-expiry one)
- rotate `op://prod-smoke/admin-jwt/password` every 25 days. It's a
  30-day ES256 token used by the hosted product-proof smoke; if it
  expires, smoke step `Checking admin async XCM status` 401s and
  every Deploy Production run fails until rotated. Mint via
  `scripts/ops/mint-admin-jwt.mjs --use-kms` per
  [`OPERATOR_ONBOARDING.md`](./OPERATOR_ONBOARDING.md) §5.4.
- complete Stage 2C-3 HMAC retirement: ≥30 days after 2026-05-21,
  delete `op://prod-backend/auth-jwt-secrets`, drop the HMAC code
  branch from `mcp-server/src/auth/jwt.js`, and retire
  `AUTH_JWT_SECRETS` from the secrets inventory and rotation
  calendar. Until then, the HMAC secret is still on disk in
  `/run/agent-stack/backend.env` even though the dispatcher refuses
  to use it.
- add operator docs that distinguish signing secrets (KMS keys, never
  exportable) from bearer JWTs (rotatable, leakable, finite-TTL) —
  partly closed by
  [`OPERATOR_ONBOARDING.md`](./OPERATOR_ONBOARDING.md) §5.4 and §6,
  but the dedicated "what is a signing secret" section is still TODO.

### Credential Provisioning Pipeline Compromise

Risk: IAM Roles Anywhere replaces a single high-trust artifact (the
static IAM access key) with a chain of artifacts — self-signed CA
private key, trust-anchor configuration, client cert + key, signing
helper binary, AWS shared-config file. Each link is a new
supply-chain surface; tampering with any one can let an attacker mint
STS sessions as the JWT signer role or the blockchain signer role.

Current mitigation:

- the self-signed CA private key never lives on the VPS — operator
  generates it locally, uploads to 1Password (`op://prod-critical/
  roles-anywhere-ca`), shreds the local copy. Per-cert issuance is a
  one-shot operator action that re-downloads, signs, and shreds again.
  See [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
  §"CA private key handling"
- `aws_signing_helper` binary integrity is verified against the
  AWS-published SHA256 checksum at install per
  [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
  §5.1; the binary lives at `/usr/local/bin/aws_signing_helper` (mode
  `0755`, owned by `root`) and is mounted read-only into the backend
  container
- client cert + key files in `/etc/agent-stack/roles-anywhere/` are
  mode `0400` owned by `root`, mounted read-only into the container;
  no other process on the VPS can read them
- the JWT signer role's IAM permissions policy
  (`deploy/iam-policies/averray-jwt-signer-prod-role.json`) is
  intentionally sign-only: `kms:Sign` with `ECDSA_SHA_256` + `DIGEST`
  condition keys, `kms:GetPublicKey`, and an explicit `Deny` on
  `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:PutKeyPolicy`,
  `kms:CreateGrant`, `kms:ReplicateKey`, `kms:UpdatePrimaryRegion` —
  a compromised role can mint tokens but cannot kill the key or
  silently re-target it
- IAM Roles Anywhere role trust policy requires
  `aws:PrincipalTag/x509Subject/CN` to match the expected CN and
  `aws:SourceArn` to match the trust-anchor ARN — a stolen client cert
  used against an attacker's trust anchor would be rejected

Follow-up:

- add CloudTrail alarms for `sts:AssumeRoleWithSAML` /
  `sts:AssumeRoleWithWebIdentity` calls from outside the expected VPS
  source IP / subnet ranges
- add an integrity check at deploy time that re-verifies
  `aws_signing_helper` checksum (catches a future supply-chain
  poisoning between install and the next operator-triggered re-install)
- consider an SCP at the AWS account / org level that explicitly
  refuses any IAM action targeting the JWT or blockchain signer keys
  from a principal other than the deploy account's IAM admin —
  belt-and-braces against a compromised IAM user that has broad-enough
  permissions to bypass the signer role's narrow policy

### Boot-Time Credential-Check Bypass

Risk: `JWT_KMS_CREDENTIAL_CHECK_SKIP=1` is an explicit emergency-bypass
flag for the boot-time JWT KMS credential check (a `kms:GetPublicKey`
call that exercises the full Roles Anywhere → KMS path before the
backend accepts requests). A stray production-set flag would hide the
misconfiguration the check exists to catch.

Current mitigation:

- the flag is documented as emergency-only in
  [`OPERATOR_ONBOARDING.md`](./OPERATOR_ONBOARDING.md) §6, with a
  guardrail telling the operator to remove it once the underlying
  issue is fixed and never to ship a PR that defaults it on
- the bypass logs a `warn`-level `jwt-kms-credential-check.skipped`
  line at every container start when the flag is set, so the bypass
  is visible in normal log inspection
- the flag does NOT bypass actual `kms:Sign` calls — runtime SIWE +
  refresh flows still require a working credential chain; the flag
  only defers the failure from boot to the first user-facing request

Additional mitigation (H1, added):

- `scripts/ops/check-forbidden-prod-env.mjs` runs in CI (Phase 2 job,
  right after the structural lint) and **fails closed** if
  `JWT_KMS_CREDENTIAL_CHECK_SKIP` (or its `_ACK_PRODUCTION` companion, or
  `AUTH_ALLOW_PERMISSIVE_BROKERING`) is committed *enabled* in any env
  template. A clean template cannot render a dirty
  `/run/agent-stack/backend.env` — `op inject` only substitutes `op://`
  refs, it never adds keys — so guarding the committed templates catches
  the accidental-ship vector at PR time, earlier than the backend's
  boot-time guard. Emergency use stays a supervised runtime-only override
  (never committed), acknowledged in-process via
  `JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION`.

Follow-up:

- extend the guard to the deploy step: have the render/deploy path run
  `check-forbidden-prod-env.mjs --file /run/agent-stack/backend.env`
  (the `--file` mode already exists) so a runtime override is also gated,
  optionally keyed to an active-incident acknowledgement in
  [`MULTISIG_DECISION.md`](./MULTISIG_DECISION.md) or `INCIDENT_RESPONSE.md`.
- add an `/admin/status` field that surfaces "boot check skipped" so
  operators can see at a glance that the platform is running with the
  safety bypass on

## Truth-Boundary Discipline

Risk: any UI, API, or status surface that smooths over a degraded backend
or renders demo data indistinguishable from real data directly contradicts
the platform's trust pitch. The
[`docs/AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md) remediation board
treats this as the load-bearing cross-cutting pattern behind P1.1, P1.1b,
P1.2, P1.3, P2.4, P2.5, and P2.5b.

Current mitigation:

- public-site homepage console relabeled from "Live" to "Example" (Package F,
  PR #405); deterministic animation no longer claims to be a real SSE feed
- operator-app structured-submission guard rejects malformed validation
  responses rather than silently falling through to a successful-looking
  submit (`app/lib/api/guarded-submit.js`)
- account overlay merge precedence inverts so live chain reads always win
  over stored cache per-key (Package C, PR #408); stale cache can no longer
  silently override fresh on-chain state
- AUDIT_PACKAGE §6 deployment parameters reads from
  `deployments/testnet.json` directly so the auditor-facing values cannot
  drift from the deployed values
- INCIDENT_RESPONSE §1 ownership block is filled rather than left as
  `<placeholder>` (PR #390)

Follow-up:

- finish Package E — operator pages adopt explicit `live` / `empty` /
  `degraded` / `demo` modes with a persistent banner when
  `NEXT_PUBLIC_DEMO_MODE=true`
- keep `/metrics` and `/graphql` gated in production by setting the bearer tokens
  documented in `deploy/backend.env.template` and
  `deploy/indexer.env.template`
- continue documenting `<TBD>` placeholders as work items, not as silent
  defaults

## Launch Posture

Averray is production-like on testnet once the hosted smoke checks, discovery
publish flow, and bootstrap instrumentation are green. It is not mainnet-ready
until mainnet parameters, audit sign-off, incident ownership, and async XCM
staging evidence are complete.

`v1.0.0-rc1` close progress as of 2026-05-21:

- Multisig owner control plane is live on testnet
  (`deployments/testnet-multisig-owner.json` is `status: "verified"`)
- KMS-backed backend **blockchain** signer is live (Phase 3 cutover
  2026-05-16, `SIGNER_BACKEND=kms`)
- KMS-backed backend **JWT** signer is live (Phase 4b Stage 2C-2
  cutover 2026-05-21, `JWT_BACKEND=kms`). Verifier refuses HS256;
  multi-role ES256 active in SIWE, refresh, and service-token paths.
- IAM Roles Anywhere is the active credential source for both signers
  (Phase 5a cutover 2026-05-21). Static IAM access keys retired from
  the env template via PR #463 (Stage 2C-3); 1Password retention for
  the static keys is the 30-day rollback window before Phase 5a-retire.
- Audit remediation board ([`docs/AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md))
  has closed Packages A, F, H, C, and I; Packages B, D, E, G, and J
  still open. `OPERATOR_ONBOARDING.md` was refreshed for the Phase
  4b/5a state in PR #468; this threat-model refresh is its sibling.
- The remaining `v1.0.0-rc1` P0 launch gates in
  [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md) §"P0 Launch Gates" are
  operator-side (multisig `setVerifier` call from the audit, pause/
  unpause rehearsal, backup readiness + restore drill, metrics +
  Sentry + alert-destination operator-set values, dispute verdict
  hosted proof) and a small set of code/ops items
  (`/admin/status` async XCM smoke, public discovery/schema/trust
  gate + canonical API mirror proof).
- External contract audit has not yet been engaged. See
  [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) and
  [`STRATEGY_ADAPTER_AUDIT_SCOPE.md`](./STRATEGY_ADAPTER_AUDIT_SCOPE.md) for
  the audit-firm-facing scope documents.
