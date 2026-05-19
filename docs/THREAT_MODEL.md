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
- backend signer is **KMS-backed** since the 2026-05-16 Phase 3 cutover
  (`SIGNER_BACKEND=kms` in `deploy/backend.env.template`); the private key
  material lives only inside AWS KMS and is non-exportable. The backend
  only ever calls `kms:Sign`. See [`docs/SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md).

Follow-up:

- keep signer duties separated from hot operational wallets
- finish the recovery playbook dry run for lost-key scenarios
- require multisig review for any mainnet-adjacent owner mutation
- migrate the `DISCOVERY_PUBLISHER_PRIVATE_KEY` (still a raw private key in
  GitHub Secrets) to a KMS-backed signer, mirroring the Phase 3 backend
  pattern. Practical risk is bounded — that key only publishes manifest
  hashes — but the asymmetry is worth closing once Phase 4c lands.

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
- `/metrics` on `api.averray.com` accepts an optional `METRICS_BEARER_TOKEN`
  Bearer gate; the env var is documented in
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
used until expiry or revocation.

Current mitigation:

- JWTs expire and can be revoked through logout
- production auth is strict SIWE JWT auth
- secrets are stored in GitHub Actions secrets, not committed to the repo

Follow-up:

- rotate any API key or token pasted into shared chat
- add operator docs that distinguish signing secrets from bearer JWTs

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
- gate `/metrics` and `/graphql` in production by setting the bearer tokens
  documented in `deploy/backend.env.template` and
  `deploy/indexer.env.template`
- continue documenting `<TBD>` placeholders as work items, not as silent
  defaults

## Launch Posture

Averray is production-like on testnet once the hosted smoke checks, discovery
publish flow, and bootstrap instrumentation are green. It is not mainnet-ready
until mainnet parameters, audit sign-off, incident ownership, and async XCM
staging evidence are complete.

`v1.0.0-rc1` close progress as of 2026-05-17:

- Multisig owner control plane is live on testnet
  (`deployments/testnet-multisig-owner.json` is `status: "verified"`)
- KMS-backed backend signer is live (Phase 3 cutover 2026-05-16)
- Audit remediation board ([`docs/AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md))
  has closed Packages A, F, H, C, and I; Packages B, D, E, G, and J still open
- External contract audit has not yet been engaged. See
  [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) and
  [`STRATEGY_ADAPTER_AUDIT_SCOPE.md`](./STRATEGY_ADAPTER_AUDIT_SCOPE.md) for
  the audit-firm-facing scope documents.
