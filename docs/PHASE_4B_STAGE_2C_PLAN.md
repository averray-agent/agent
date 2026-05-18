# Phase 4b Stage 2C — Service-token ES256 migration + JWT_BACKEND=kms flip

Audit + implementation plan. **No code in this document.** Treat as the
review surface; once approved, the work splits into 2-3 PRs.

## TL;DR

Stage 2C is the final step in retiring HMAC from the auth stack. After
this lands the backend signs **and** verifies all tokens — including
service tokens — exclusively via the AWS KMS ES256 key. The HMAC code
path stays for forensic decoding only; `op://prod-backend/auth-jwt-secrets`
can be deleted ≥30 days later per the SECRETS_MIGRATION.md retirement table.

**Scope is smaller than expected** because Averray has no long-lived
service tokens in production today — every service token is issued
on-demand by `scripts/ops/check-service-token-proof.mjs` and discarded
within the same CI run. No mass re-issuance is required.

## 1. Service-token surface — what exists today

### Mint path

`mcp-server/src/protocols/http/server.js` → `signServiceToken(grant, payload)`
at L1426:

```js
return signToken(
  {
    sub: grant.subject,
    roles: [],                      // explicitly empty — service tokens have no roles
    tokenKind: "service",
    serviceToken: true,             // duplicate-encoded for forward-compat
    capabilityGrantId: grant.id,    // pointer into stateStore capability_grants
    ...(grant.scope ? { serviceScope: grant.scope } : {})
  },
  { secret: authConfig.signingSecret, expiresInSeconds: ttlSeconds }
);
```

Called from three admin endpoints in server.js:
- `POST /admin/service-tokens` — initial issue
- `POST /admin/service-tokens/:id/rotate` — rotate (revokes old, issues new)
- `POST /admin/service-tokens/:id/revoke` — revoke only (no new token)

TTL: defaults to `authConfig.tokenTtlSeconds` (24h), capped at
`SERVICE_TOKEN_MAX_TTL_SECONDS` (30d). Caller can request shorter.

### Verify / authorize path

`mcp-server/src/auth/middleware.js` → `expandCapabilities(claims, base)`
at L73 detects service-token shape via `isServiceTokenClaims`:

```js
return claims?.serviceToken === true || claims?.tokenKind === "service";
```

For service tokens, the middleware:
1. Returns `base = []` from `resolveCapabilities` (service tokens get NO
   wallet-tier base capabilities — `capabilities.js:177`)
2. Looks up the `capabilityGrantId` in the state store
3. Asserts the grant's subject matches the JWT's `sub`
4. Asserts the grant is still active (not revoked, not expired)
5. Merges the grant's allowed capabilities into the request's
   capability set

Net: a service token is a pointer-to-grant — the grant is the source
of truth for what the token can do.

### Consumers

- `scripts/ops/check-service-token-proof.mjs` — CI smoke. Issues a
  fresh 10-minute token, exercises it on `/jobs/preflight`, asserts it
  CANNOT reach denied paths, then revokes. Runs per-deploy.
- `/admin/service-tokens` admin UI surface in the operator app
- **No long-lived service tokens are stored in 1Password or anywhere
  else.** `op://prod-smoke/admin-jwt` is a *wallet* token (admin role),
  not a service token.

## 2. KmsJwtSigner constraints vs. service-token claims

Mapping the existing claim shape onto the KmsJwtSigner schema:

| Current HS256 claim | ES256 path | Notes |
|---|---|---|
| `sub` | `subject` (KmsJwtSigner opt) | Must be lowercase; grant.subject is already lowercased EVM addr |
| `roles: []` | ❌ Empty array rejected by signAsync | **Needs resolution** — see option A below |
| `tokenKind: "service"` | extra claim (in payload) | Passes through unchanged |
| `serviceToken: true` | extra claim | Passes through |
| `capabilityGrantId` | extra claim | Passes through |
| `serviceScope` (optional) | extra claim | Passes through |
| `jti` (auto) | KmsJwtSigner sets (UUIDv4) | Stage 2B made existing `claims.jti` parsing UUIDv4-strict; consumers (revocation, state-store) already treat jti as opaque string |
| `iat` (auto) | KmsJwtSigner sets | |
| `exp` (auto) | KmsJwtSigner sets | |
| *no nbf* | KmsJwtSigner adds `nbf = iat` | New claim on ES256 tokens; tolerated by every existing consumer (no one reads nbf except KmsJwtSigner.verify) |

### Option A — synthetic `service` role claim

Add `"service"` to the role allowlist (`JWT_EXPECTED_ROLES` env var)
and have `signServiceToken` pass `role: ["service"]` to the dispatcher.

Verifier accepts the token; downstream code keeps using
`isServiceTokenClaims(claims)` to distinguish service from wallet
tokens (already does, no change needed). The synthetic role is
informational — capabilities are NOT derived from it.

**Pro**: minimal change, fits cleanly into Stage 2B's multi-role
`roles: array` shape. Cost: one extra entry in `JWT_EXPECTED_ROLES`.

### Option B — relax KmsJwtSigner to accept empty roles

Allow `roles: []` (or absent `roles`) at sign + verify when the token
is a service token (`tokenKind === "service"`).

**Con**: introduces a conditional branch in the verifier that examines
non-registered claims to decide whether the registered claim
requirement applies. Strictly worse for security review — verifier
logic should be claim-shape-independent. Reject this option.

**Recommendation: Option A.** Cleaner blast radius, no verifier
complexity, the `"service"` role is honest about what the token is
(an `expectedRoles` allowlist entry rather than a magic null).

## 3. Implementation phases

Split into 3 PRs for clean rollback at each step.

### PR 2C-1 — Code migration (zero runtime change)

- Add `"service"` to `JWT_EXPECTED_ROLES` env in `deploy/backend.env.template`
  (defaults today to the literal `[...VALID_ROLES]` which is `["admin","verifier"]`)
- Update `parseJwtRoles` in `mcp-server/src/auth/config.js` to allow
  `"service"` as a valid role (currently rejects anything not in
  `VALID_ROLES = {"admin", "verifier"}`)
- `signServiceToken` in `server.js` switches from `signToken` to
  `signTokenFromConfig`:
  - Pass `role: ["service"]` instead of `roles: []`
  - Keep the other claims (`tokenKind`, `serviceToken`, `capabilityGrantId`,
    `serviceScope`) in the payload — they ride through the dispatcher's
    extras-spread
- `signServiceToken` becomes async (because `signTokenFromConfig` is)
- Update all three admin handlers that call `signServiceToken` to await
- Tests: extend `jwt-dispatcher.test.js` with service-token claim shape
  round-trip under both `JWT_BACKEND=both` and `=kms`. Hand-craft an
  HS256 service token (the existing pre-2C shape) and confirm verify
  accepts it under `=both`.

Effect at deploy: `JWT_PRIMARY_ALG=kms` from Stage 2B is still in
effect. Service-token mints now route through the dispatcher's KMS
sign path. Existing HS256 service tokens (≤ 30d old) continue to
verify under `JWT_BACKEND=both`. Zero user-visible change.

**Risk**: low. The async-ification of `signServiceToken` is the main
mechanical risk; one missed `await` would surface as a `[object
Promise]` token, immediately caught by `check-service-token-proof.mjs`
in CI.

**Rollback**: revert this PR; `signServiceToken` reverts to legacy
HS256 mint, all in-flight ES256 service tokens continue to verify
under `=both` until their TTL expires.

### PR 2C-2 — JWT_BACKEND=kms env flip

- `deploy/backend.env.template`: `JWT_BACKEND=both` → `JWT_BACKEND=kms`
- Add a comment block describing the cutover state and the rollback path
- Update `docs/SECRETS_MIGRATION.md` Phase 4b status table

Effect at deploy:
- Verify path no longer accepts HS256. Any in-circulation HS256 token
  (operator-app sessions older than the access-token TTL; service
  tokens older than `tokenTtlSeconds`) is rejected.
- Sign path was already kms-only under `JWT_PRIMARY_ALG=kms`. No change.

**Timing**: schedule for a low-traffic window. The blast radius is
"every active operator session that hasn't refreshed since Stage 2B
flipped". Refresh-flow sessions roll over within 15 minutes. Worst
case is the legacy SIWE flow with a 24h access-token TTL — users with
sessions issued ≥24h before this flip would need to re-SIWE.

**Pre-flight check**: query the backend metrics for the count of
HS256-token verifies in the last hour. If non-zero and unexpected,
investigate before flipping.

**Rollback**: comment out the line (revert to `both`) and redeploy.
~3 minute round-trip back to dual-mode.

### PR 2C-3 — HMAC code path retirement (deferred ≥30 days)

After 2C-2 has been clean in prod for ≥30 days:

- Delete `AUTH_JWT_SECRETS` from `deploy/backend.env.template` (or mark
  optional)
- Delete `op://prod-backend/auth-jwt-secrets` from the prod-backend
  vault (the operator runbook step)
- Remove the HS256 verify branch from `mcp-server/src/auth/jwt.js`
  (`verifyTokenFromConfig` → unconditional ES256 routing); the
  in-process HMAC sign/verify code can stay for unit-test fixtures but
  the prod boot path should never construct an HMAC verifier
- Update `secrets-inventory.md` to mark `AUTH_JWT_SECRETS` as retired
- Update `SECRETS_CALENDAR.yml` to remove `auth-jwt-secrets` rotation
  cadence

This PR is the actual "HMAC is gone" moment. Track via a calendar
reminder set when PR 2C-2 lands.

## 4. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| `signServiceToken` async-ification missed at a caller | Low | Medium (returns Promise as string) | CI smoke (`check-service-token-proof.mjs`) catches it within 5 min |
| HS256 service token in the wild gets rejected post-`JWT_BACKEND=kms` | Medium | Low (re-issue is trivial) | All known consumers issue on-demand; communicate the cutover window |
| KmsJwtSigner rejects synthetic `"service"` role | None | High (boots break) | `JWT_EXPECTED_ROLES` env explicitly includes `"service"` in PR 2C-1; config.test.js adds a positive test |
| KMS outage post-cutover | Same as Stage 2B | High (no fallback) | Same as Stage 2B — accepted residual risk for testnet, mainnet has multi-region requirement |
| Service-token `nbf` claim trips a downstream consumer that didn't tolerate it before | None observed | Low | Grep confirms no consumer reads `nbf`; KmsJwtSigner.verify is the only path that validates it |

## 5. Open questions for review

1. **Should `signServiceToken` mint short-lived tokens by default?**
   Today the default TTL is `authConfig.tokenTtlSeconds` (24h). Under
   ES256 / KMS the per-sign cost is real (~50ms KMS API call) so we
   might want to recommend shorter TTLs + more rotation. Out of scope
   for 2C — track as a follow-up.

2. **Should `JWT_EXPECTED_ROLES` move from "merge into allowlist" to
   "exact list"?** Today it's parsed via `parseJwtRoles` which validates
   each entry against `VALID_ROLES = {"admin", "verifier"}` — adding
   `"service"` requires loosening that validator. Two options:
   (a) widen `VALID_ROLES` to include `"service"` permanently
   (b) make `VALID_ROLES` configurable per deploy
   Recommend (a) — `"service"` is now a first-class role concept,
   matches `tokenKind: "service"` semantics.

3. **Stage 2C-2 timing**: should we wait some number of days after 2B
   to flip `JWT_BACKEND=kms`? My read: 24-48h is enough to confirm
   2B is stable. Aggressive: same day. Conservative: 1 week.

4. **Service-token revocation under ES256**: the `revokeToken(jti)`
   mechanism in `stateStore` works on jti regardless of alg. No change
   needed. Worth confirming the test for this exists.

## 6. Decision log

- **Add `"service"` as a first-class role** (not a magic-null token shape).
  Rationale: simpler verifier, clearer audit log, fits cleanly into
  the multi-role array shape Stage 2B established.
- **Split into 3 PRs** (code migration / env flip / HMAC retirement)
  rather than one big PR. Rationale: each step is independently
  rollable, blast radii are bounded, and the 30-day retirement timer
  on PR 2C-3 is a hard separator anyway.
- **No mass token re-issuance** is needed. Confirmed by reading every
  consumer in `scripts/ops/`. The CI smoke (`check-service-token-proof.mjs`)
  creates and discards tokens within a single run.
