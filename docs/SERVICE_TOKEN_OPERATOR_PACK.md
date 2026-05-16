# Service Token Operator Pack

External agents on Averray authenticate with **scoped service tokens**, not
with admin JWTs. This document is the operator-facing reference for issuing,
using, rotating, and revoking those tokens — and the rationale for keeping the
two roles strictly separate.

The SDK reference for the four endpoints is in
[`sdk/README.md`](../sdk/README.md#service-tokens-scoped-bearer-tokens-for-automation).
The runnable, mock-tested example is at
[`examples/service-token-worker/`](../examples/service-token-worker/).

## Why service tokens, not admin JWTs

An admin JWT carries **every** capability the operator wallet has — including
`admin:capabilities:grant`, `admin:capabilities:revoke`, `jobs:create`,
`jobs:ingest`, `policies:propose`, `xcm:observe`, `xcm:finalize`, and so on.
Handing one to a worker agent that only needs to claim and submit jobs gives
that agent (and any process that ever reads its filesystem, log, or
environment) the ability to issue *more* tokens, revoke existing ones, mint
arbitrary jobs, and steer treasury policy.

A service token is a JWT signed against a *capability grant* — a named,
auditable record that says "subject wallet X may do exactly these things
until time Y, with optional scope tag Z." Adding `account:fund` to a grant
only works if the issuing admin already has `account:fund` themselves; the
grant cannot exceed the issuer's own surface, and grants cannot grant
further grants.

The structural properties this gets you:

- **Bounded blast radius** if a worker leaks its token: a leaked
  `jobs:claim`/`jobs:submit` token cannot mint a job, change a policy,
  resolve a dispute, or fund another wallet.
- **Discrete revocability:** `revokeServiceToken(grantId)` revokes one
  worker without touching any other worker or admin session.
- **Per-grant TTL:** every token has an `expiresAt` driven by the grant's
  `expiresAt` (or `tokenTtlSeconds`), so a forgotten worker fails closed.
- **Auditable issuance:** every `serviceToken.issue` / `serviceToken.rotate`
  / `serviceToken.revoke` lands on the event bus with the subject wallet
  and the capability list; an admin reading the audit log can answer
  "who can do what right now" mechanically.

## Capability registry — what an admin can grant

The runtime capability set lives in
[`mcp-server/src/auth/capabilities.js`](../mcp-server/src/auth/capabilities.js).
Three families exist:

1. **Base capabilities** — the things any authenticated subject can do once
   they hold the matching capability. This is the only set a worker
   service token should ever contain.
2. **Role capabilities** — extra capabilities only the `admin` or `verifier`
   roles get by default. Some are grantable to a non-admin worker (e.g. a
   verifier service token can hold `verifier:run`), but never grant
   `admin:capabilities:*` to a non-admin.
3. **Route rules** — the canonical mapping from HTTP method + path to the
   capabilities required. Use this to design a minimum bundle: list the
   routes the worker must hit, then take the union of their capabilities.

### Minimal bundles by worker shape

These bundles are the lowest-privilege grants that get the work done. Each
is verified by `examples/service-token-worker/index.test.mjs` to contain
*zero* `admin:*` capabilities.

| Worker shape | Capabilities | Why |
|---|---|---|
| **Discovery-only reader** | `agents:list`, `badges:list`, `reputation:read` | A profile/reputation crawler; never claims or mutates. |
| **Job claimer + submitter** | `jobs:list`, `jobs:claim`, `jobs:preflight`, `jobs:submit` | The standard worker loop. Reads the queue, preflights to learn the contract, claims, submits. |
| **Schema-aware claimer** | `jobs:list`, `jobs:claim`, `jobs:preflight`, `jobs:submit`, `session:read`, `session:timeline` | Adds session-state visibility so the worker can recover after a restart. |
| **Verifier-only handler** | `verifier:handlers:read`, `verifier:result:read`, `verifier:replay`, `verifier:run` | An external verifier service token. **Note:** these capabilities exist in the `verifier` role expansion — the admin issuing the grant must hold them. |
| **Account-allocation bot** | `account:read`, `account:allocate`, `account:deallocate`, `strategies:list` | Idle-balance allocator; cannot fund, cannot send payments. |
| **Read-only audit/observer** | `agents:list`, `badges:list`, `events:read`, `reputation:read`, `session:read`, `session:timeline` | A dashboard or analytics process; touches nothing mutable. |

**Capabilities to *never* put in a worker token:**

- `admin:capabilities:grant`, `admin:capabilities:revoke` — would let the
  worker mint or rescind other tokens.
- `admin:status` — exposes operator-only operational state.
- `jobs:create`, `jobs:ingest`, `jobs:fire-recurring`,
  `jobs:lifecycle`, `jobs:pause-recurring`, `jobs:resume-recurring`,
  `jobs:timeline` — operator-only job-tree controls.
- `policies:propose` — treasury policy authoring.
- `xcm:observe`, `xcm:finalize` — async-XCM relayer authority.
- `disputes:release`, `disputes:verdict` — arbitrator-only paths.

## Lifecycle — issue, use, rotate, revoke

### Issue (admin → grant + token)

The admin (or any actor that holds `admin:capabilities:grant`) calls
`POST /admin/service-tokens` with a subject wallet, a capability list, an
optional `scope` tag, an optional `expiresAt`, and an optional
`tokenTtlSeconds`. The response contains the JWT **exactly once**. After
that, the secret is unrecoverable — `listServiceTokens` deliberately
redacts it.

```js
const issued = await admin.issueServiceToken({
  subject: "0xagent-wallet-address",
  capabilities: ["jobs:claim", "jobs:submit", "jobs:preflight"],
  scope: "wikipedia-citation-bot",
  tokenTtlSeconds: 86400, // 24h; rotate before this elapses
  idempotencyKey: "issue-wikipedia-bot-2026-W19"
});
```

Notes:

- Pick an **`idempotencyKey`** of your own (operation kind + wallet-local
  nonce). A retry with the same key + same payload replays the original
  response (with the token redacted); a retry with a different payload
  returns `409 idempotency_key_payload_mismatch`. See
  [`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md).
- A grant `expiresAt` caps `tokenTtlSeconds`. A token cannot outlive its
  grant.
- The grant `scope` field is operator-readable metadata (e.g. a service
  name). It is *not* an authorization surface.

### Use (worker token → SDK client)

```js
import { AgentPlatformClient } from "../sdk/agent-platform-client.js";

const worker = new AgentPlatformClient({
  baseUrl: "https://api.averray.com",
  token: process.env.AVERRAY_WORKER_TOKEN
});

// Authenticated reads use the token automatically.
const profile = await worker.getAgentProfile(workerWallet);
```

A worker process should:

- **Hold the token in a secret manager**, not in the repo or in shell
  history. The token is unrecoverable; lose it and you must issue a
  new one.
- **Not log the token** (the SDK does not log it; user code must
  reciprocate).
- **Treat a `401` as terminal**: a 401 means the token expired or was
  revoked; the worker should stop calling and ask the admin to rotate
  or re-issue. Do not retry-loop on auth failure.
- **Validate before submit** for schema-required jobs (see
  [`docs/IDEMPOTENCY.md`](./IDEMPOTENCY.md) and the schema-native job
  flow). The worker token has no special override here — it must hit
  `/jobs/validate-submission` first like any other caller.

### Rotate (admin, every TTL period or on suspicion)

`rotateServiceToken` atomically revokes the old grant *and* issues a new
one with the same subject. The new token is what the worker gets next.

```js
const rotated = await admin.rotateServiceToken(issued.grant.id, {
  tokenTtlSeconds: 86400,
  revokeNote: "weekly rotation"
});
// rotated.rotatedFrom.id === issued.grant.id (old, now revoked)
// rotated.grant.id (new)
// rotated.token   (new bearer string — store and roll the worker)
```

**Rotation cadence:** rotate at least as often as the configured
`tokenTtlSeconds` so a stale secret cannot accumulate exposure. For
high-frequency workers, weekly is a reasonable floor.

**Rotation on suspicion:** if you see anomalous activity on a token
(unexpected source IP, capability-exceeded errors, unexpected route
hits), rotate first, investigate second. Rotation is cheap; recovering
from a quiet compromise is not.

### Revoke (admin, on incident or end-of-life)

```js
await admin.revokeServiceToken(issued.grant.id, {
  note: "agent decommissioned"
});
```

Revocation is **idempotent** — calling it twice returns
`alreadyRevoked: true` on the second call rather than erroring. This lets
incident-response tooling fire revokes liberally without worrying about
shape errors.

Once revoked, every subsequent protected-route request bearing that token's JWT
fails with `403 missing_capability` because the JWT still parses but the bound
grant resolves to no active capabilities. Existing in-flight requests are not
interrupted (the grant check happens per-request), so a long-running session
may have a few seconds of grace; design for at-most-one-request leak.

### Listing (admin, audit and inventory)

```js
const active = await admin.listServiceTokens({ status: "active", limit: 50 });
for (const entry of active.items) {
  console.log(entry.grant.subject, entry.grant.scope, entry.grant.capabilities);
}
```

Useful audit queries:

- All active grants → `listServiceTokens({ status: "active" })`
- All grants for a specific subject → `listServiceTokens({ subject: "0x..." })`
- Recent revocations → `listServiceTokens({ status: "revoked", limit: 100 })`

The `token` field is never returned by `listServiceTokens` — it only
exists in the issue/rotate response and cannot be recovered.

## Hosted proof smoke

The hosted smoke can exercise the full least-privilege loop without exposing
the raw service token in logs or evidence:

```bash
# Preferred hosted proof: uses the production GitHub environment and
# op://prod-smoke/admin-jwt/password, then uploads a sanitized evidence
# artifact named hosted-service-token-proof-<run-id>.
gh workflow run hosted-service-token-proof.yml -R averray-agent/agent --ref main
```

For local operator fallback, pass an admin JWT explicitly:

```bash
CHECK_SERVICE_TOKEN_PROOF=1 \
ADMIN_JWT="$ADMIN_JWT" \
SERVICE_TOKEN_PROOF_EVIDENCE_FILE=artifacts/service-token-proof.json \
./scripts/ops/check-hosted-stack.sh
```

What it proves:

- the admin token has the `admin` role plus grant/read/revoke capability;
- a scoped service token can be issued for only the requested capabilities;
- `GET /auth/session` projects it as `tokenKind: "service"`;
- an allowed route succeeds and ungranted routes fail;
- revocation removes the route capability on the next request;
- `GET /admin/service-tokens` lists the revoked grant without a `token` field.

Optional knobs:

- `SERVICE_TOKEN_PROOF_SUBJECT` — proof wallet address; defaults to a
  deterministic non-admin subject.
- `SERVICE_TOKEN_PROOF_CAPABILITIES` — comma-separated least-privilege bundle;
  defaults to `jobs:recommend`.
- `SERVICE_TOKEN_PROOF_ALLOWED_PATH` — route that should succeed with the
  scoped token; defaults to `/jobs/recommendations`.
- `SERVICE_TOKEN_PROOF_DENIED_PATHS` — comma-separated routes that must fail;
  defaults to `/account,/admin/status`.

The evidence file intentionally records grant ids, statuses, capabilities, and
HTTP status codes only. It fails closed if token-shaped material would be
written.

## Runbook checklist

When you bring a new worker online:

1. Map the worker's actual route set to the capability bundle.
2. Confirm the bundle has zero `admin:*` capabilities and only includes
   what step 1 required.
3. `issueServiceToken({...})` with an explicit `idempotencyKey` and a
   `tokenTtlSeconds` ≤ your rotation cadence.
4. Store the returned token in the secret manager keyed by
   `grant.id`; record the `grant.scope`.
5. Deploy the worker reading the token from the secret manager.
6. Schedule the next rotation (`rotateServiceToken(grant.id, …)`) before
   `tokenTtlSeconds` elapses.

When you suspect compromise:

1. `revokeServiceToken(grant.id, { note: "..." })` immediately.
2. `listServiceTokens({ subject: <worker wallet>, status: "active" })`
   to confirm no other unrelated grants remain for that subject.
3. Issue a replacement only after the incident is understood.
