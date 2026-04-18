# VPS Runbook

This runbook captures the production-like setup currently running on the OVH VPS for `averray.com`.

## Stack layout

- Stack root on server: `/srv/agent-stack`
- Repo checkout: `/srv/agent-stack/app`
- Compose file: `/srv/agent-stack/docker-compose.yml`
- Recommended repo-owned Caddy template: [deploy/Caddyfile.averray](/Users/pascalkuriger/repo/Polkadot/deploy/Caddyfile.averray)
- Infra services:
  - `agent-postgres`
  - `agent-redis`
  - `agent-caddy`
- App services:
  - `agent-backend`
  - `agent-indexer`

## Public endpoints

- Main site: [https://averray.com](https://averray.com)
- Discovery: [https://averray.com/.well-known/agent-tools.json](https://averray.com/.well-known/agent-tools.json)
- LLM index: [https://averray.com/llms.txt](https://averray.com/llms.txt)
- Sitemap: [https://averray.com/sitemap.xml](https://averray.com/sitemap.xml)
- Public agent profiles: `https://averray.com/agents/<wallet>`
- App: [https://app.averray.com](https://app.averray.com)
- API: [https://api.averray.com](https://api.averray.com)
- API SSE: `https://app.averray.com/api/events?token=<jwt>` (strict mode) or `?wallet=0x...` (permissive only)
- Indexer: [https://index.averray.com](https://index.averray.com)
- Gas sponsor health: [https://api.averray.com/gas/health](https://api.averray.com/gas/health)

## Caddy routing shape

The intended production split is:

- `averray.com` / `www.averray.com` → static public site from `app/site`
- `app.averray.com` → static operator app from `app/frontend`
- `api.averray.com` → reverse proxy to backend container
- `index.averray.com` → reverse proxy to indexer container

The repo-owned template lives at:

```text
/Users/pascalkuriger/repo/Polkadot/deploy/Caddyfile.averray
```

To protect only the operator surface with browser basic auth, render the
live file through:

```text
/Users/pascalkuriger/repo/Polkadot/scripts/ops/render-caddyfile.sh
```

On the VPS, the live file should be:

```text
/srv/agent-stack/Caddyfile
```

Key routing rules:

- `averray.com/` is the generated Astro landing page synced into `site/index.html`
- `averray.com/.well-known/agent-tools.json` is served statically from `site/.well-known/`
- `averray.com/robots.txt`, `averray.com/llms.txt`, and `averray.com/sitemap.xml` are served statically from `site/`
- `averray.com/agents/:wallet` rewrites to `site/agent.html?wallet=:wallet`
- `app.averray.com/api/*` proxies to `backend:8787`
- `app.averray.com/index/*` proxies to `indexer:42069`
- inside the Caddy container, the static mounts are `/srv/site` and `/srv/frontend`

Before pushing landing page changes from your local machine, regenerate the public site shell:

```bash
npm run build:site
```

### Applying a new Caddy config

Copy the repo template onto the server and restart Caddy:

```bash
cd /srv/agent-stack/app
cp deploy/Caddyfile.averray /srv/agent-stack/Caddyfile
cd /srv/agent-stack
docker compose restart caddy
docker compose logs --tail=100 caddy
```

### Protecting `app.averray.com` with browser basic auth

This is the recommended setup while the operator/admin surface is still
actively evolving in public.

1. Pick a username, for example `operator`.
2. Pick a strong password and store it in your password manager.
3. Render the live Caddyfile instead of copying the raw template:

```bash
cd /srv/agent-stack/app
APP_BASIC_AUTH_USER=operator \
APP_BASIC_AUTH_PASSWORD='replace-with-a-strong-password' \
./scripts/ops/render-caddyfile.sh /srv/agent-stack/Caddyfile
```

4. Restart Caddy:

```bash
cd /srv/agent-stack
docker compose restart caddy
docker compose logs --tail=100 caddy
```

What this protects:

- `https://app.averray.com/`
- `https://app.averray.com/api/*`
- `https://app.averray.com/index/*`

What stays public:

- `https://averray.com/`
- `https://api.averray.com/`
- `https://index.averray.com/`

### Hosted smoke checks when app auth is enabled

If `app.averray.com` is behind browser basic auth, pass the same
credentials into the smoke check:

```bash
APP_BASIC_AUTH_USER=operator \
APP_BASIC_AUTH_PASSWORD='replace-with-a-strong-password' \
./scripts/ops/check-hosted-stack.sh
```

## Quick health checks

Run these on the VPS:

```bash
cd /srv/agent-stack
docker ps
curl -fsS https://averray.com/
curl -fsS https://api.averray.com/health
curl -fsS https://api.averray.com/gas/health
curl -fsS https://index.averray.com/
curl -fsS https://averray.com/.well-known/agent-tools.json
curl -fsS https://averray.com/llms.txt
curl -fsS https://averray.com/sitemap.xml
curl -fsS https://averray.com/agents/0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519
```

Expected signals:

- Main site returns HTML
- API health returns `status: ok`
- Gas health returns Pimlico status or a clean disabled mode
- Indexer root returns `status: ok`
- Discovery manifest returns JSON with `baseUrl` set to `https://api.averray.com`
- `llms.txt` and `sitemap.xml` return plain text / XML from the static site root
- `/agents/<wallet>` returns HTML and hydrates the public profile shell

## Redeploy flows

### Frontend-only changes

Public site and app frontend files are mounted directly into Caddy, so a repo
pull is enough:

```bash
cd /srv/agent-stack/app
git pull
```

Hard refresh the browser after pulling.

If the Caddy routing shape changed too, also restart Caddy:

```bash
cd /srv/agent-stack
docker compose restart caddy
```

If the operator app is protected with browser basic auth, re-render
`/srv/agent-stack/Caddyfile` through `scripts/ops/render-caddyfile.sh`
after pulling, then restart Caddy.

### Backend changes

Use the scripted flow from the repo checkout:

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-backend.sh
```

The script now:

1. Pins the pre-deploy SHA for rollback.
2. Fast-forwards the repo to `origin/main`.
3. Rebuilds `agent-backend`.
4. Polls `HEALTH_URL` (default `https://api.averray.com/health`) for up to
   `HEALTH_TIMEOUT_SEC` (default 120) seconds.
5. **Automatically rolls back** to the previous SHA and rebuilds if health
   never turns green. Set `SKIP_ROLLBACK=1` to leave an unhealthy deploy in
   place for debugging.

Override defaults via env:

```bash
HEALTH_URL=https://staging.api.averray.com/health \
HEALTH_TIMEOUT_SEC=180 \
./scripts/ops/redeploy-backend.sh
```

Note: the staking and slashing contract changes require a contract redeploy and refreshed backend env values, not just a backend image rebuild.

### Indexer changes

Use the dedicated indexer flow from the repo checkout:

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-indexer.sh
```

The script:

1. Pins the pre-deploy SHA for rollback.
2. Fast-forwards the repo to `origin/main`.
3. Rebuilds `agent-indexer`.
4. Polls `https://index.averray.com/health` until the process is listening.
5. Polls `https://index.averray.com/ready` until historical indexing is complete.
6. Automatically rolls back to the previous SHA if either gate fails.

Useful overrides:

```bash
# Skip the /ready gate during a known long historical backfill.
WAIT_FOR_READY=0 ./scripts/ops/redeploy-indexer.sh

# Give a heavy backfill more time before rollback.
READY_TIMEOUT_SEC=3600 ./scripts/ops/redeploy-indexer.sh
```

### Remote hosted-stack smoke test

From the repo checkout:

```bash
cd /srv/agent-stack/app/mcp-server
REMOTE_E2E_BASE_URL=https://api.averray.com \
REMOTE_E2E_PRIVATE_KEY=0xyour-test-agent-private-key \
npm run demo:e2e:remote
```

This signs in with SIWE, creates a unique remote job, runs the full claim/submit/verify flow, and confirms the session lands in hosted history. On `AUTH_MODE=permissive` deployments you may drop the private key and pass `REMOTE_E2E_WALLET=0x...` instead.

## Backups

### Postgres export

Run:

```bash
cd /srv/agent-stack/app
./scripts/ops/backup-postgres.sh
```

Backups are written to:

```text
/srv/agent-stack/backups/postgres
```

Each backup is a gzipped SQL dump:

```text
agent-YYYYMMDD-HHMMSS.sql.gz
```

### Redis snapshot export

Redis is not optional bookkeeping here: it backs SIWE nonces, JWT revocation,
claim locks, SSE/session state, and rate-limit buckets. Back it up before risky
backend/auth changes the same way you would Postgres.

Run:

```bash
cd /srv/agent-stack/app
./scripts/ops/backup-redis.sh
```

Backups are written to:

```text
/srv/agent-stack/backups/redis
```

Each backup is a gzipped Redis RDB snapshot:

```text
redis-YYYYMMDD-HHMMSS.rdb.gz
```

The script:

1. Loads `/srv/agent-stack/.env` and `/srv/agent-stack/backend.env` when present.
2. Resolves the live Redis snapshot path via `CONFIG GET dir` + `dbfilename`.
3. Forces a fresh `SAVE`.
4. Streams the resulting RDB file out of the container into a compressed backup.

### Postgres restore outline

Restore should be done deliberately and only after confirming the target file:

```bash
gunzip -c /srv/agent-stack/backups/postgres/<dump>.sql.gz | \
docker compose --project-directory /srv/agent-stack -f /srv/agent-stack/docker-compose.yml exec -T postgres \
  psql -U agent -d agent
```

Do not restore over a live database unless you mean to replace it.

### Redis restore outline

Restore should be done deliberately because it rewinds nonce, session, lock,
and token-revocation state. The safest path is:

1. Confirm the target backup file.
2. Stop the backend so it cannot mutate Redis during the restore.
3. Stop Redis.
4. Replace the Redis snapshot on disk.
5. Start Redis, then backend, then verify `/health`.

Assuming the Redis service uses the default `/data/dump.rdb` path:

```bash
TMPDIR=$(mktemp -d)
gunzip -c /srv/agent-stack/backups/redis/<dump>.rdb.gz > "$TMPDIR/dump.rdb"

cd /srv/agent-stack
docker compose stop backend redis
docker compose run --rm -T -v "$TMPDIR:/restore:ro" redis \
  sh -lc 'cp /restore/dump.rdb /data/dump.rdb'
docker compose up -d redis
docker compose exec -T redis redis-cli PING
docker compose up -d backend
curl -fsS https://api.averray.com/health

rm -rf "$TMPDIR"
```

If your Redis config uses a non-default `dir` or `dbfilename`, replace
`/data/dump.rdb` with the correct target path first:

```bash
docker compose exec -T redis redis-cli CONFIG GET dir
docker compose exec -T redis redis-cli CONFIG GET dbfilename
```

## Useful docker commands

```bash
cd /srv/agent-stack
docker compose logs --tail=100 backend
docker compose logs --tail=100 indexer
docker compose logs --tail=100 caddy
docker compose up -d --build backend
docker compose up -d --build indexer
docker compose restart caddy
```

## Files and secrets

Important server-side files:

- `/srv/agent-stack/.env` for Postgres settings
- `/srv/agent-stack/backend.env`
- `/srv/agent-stack/indexer.env`
- `/srv/agent-stack/Caddyfile`

Preferred RPC env convention:

- `DWELLER_RPC_URL` for the private/provider RPC
- `POLKADOT_RPC_URL` as a generic explicit override
- `RPC_URL` as the legacy fallback still used by older tooling

### Preparing a future Dwellir cutover

The stack is already wired so Dwellir can stay dormant until launch day.
Current precedence is:

- backend: `DWELLER_RPC_URL` -> `POLKADOT_RPC_URL` -> `RPC_URL`
- indexer: `DWELLER_RPC_URL` -> `POLKADOT_RPC_URL` -> `PONDER_RPC_URL_<chainId>`

That means you can keep the free public RPC in place today and later switch to
Dwellir without another code change.

When the live Dwellir endpoint and API key are ready:

1. Set `DWELLER_RPC_URL` in `/srv/agent-stack/backend.env`
2. Set `DWELLER_RPC_URL` in `/srv/agent-stack/indexer.env`
3. Leave the existing public-RPC vars in place during the first cutover
4. Redeploy backend and indexer
5. Verify `/health`, `/onboarding`, `/status`, and the hosted smoke check

Suggested cutover commands:

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-backend.sh
./scripts/ops/redeploy-indexer.sh
./scripts/ops/check-hosted-stack.sh
```

After the Dwellir path proves stable, you may remove the fallback public-RPC
vars in a later cleanup pass. Keeping them during the first cutover makes
rollback simpler.

Important repo-side static roots:

- `/srv/agent-stack/app/site`
- `/srv/agent-stack/app/frontend`

Optional gas sponsorship vars for `/gas/*` endpoints:

- `PIMLICO_BUNDLER_URL`
- `PIMLICO_PAYMASTER_URL`
- `PIMLICO_ENTRY_POINT`
- `PIMLICO_SPONSORSHIP_POLICY_ID`
- `PIMLICO_CHAIN_ID`

Required contract env vars for the current live-chain backend:

- `TREASURY_POLICY_ADDRESS`
- `AGENT_ACCOUNT_ADDRESS`
- `ESCROW_CORE_ADDRESS`
- `REPUTATION_SBT_ADDRESS`

Required authentication env vars (backend, strict mode):

- `AUTH_MODE=strict`
- `AUTH_JWT_SECRETS` (comma-separated HS256 secrets, each ≥32 chars)
- `AUTH_DOMAIN=api.averray.com`
- `AUTH_CHAIN_ID=420420417`

### JWT secret rotation

Zero-downtime rotation uses the multi-secret list — the **first** entry signs
new tokens, every entry in the list is accepted at verification time.

1. Generate a fresh secret (32+ chars of entropy):
   ```bash
   openssl rand -base64 48
   ```
2. Prepend it to `AUTH_JWT_SECRETS` in `/srv/agent-stack/backend.env`:
   ```text
   AUTH_JWT_SECRETS=<new>,<previous>
   ```
3. Restart the backend so new tokens are signed with the new secret:
   ```bash
   cd /srv/agent-stack/app
   ./scripts/ops/redeploy-backend.sh
   ```
4. Wait at least `AUTH_TOKEN_TTL_SECONDS` (default 24h) so every token issued
   under the old secret has expired.
5. Drop the old secret:
   ```text
   AUTH_JWT_SECRETS=<new>
   ```
   and redeploy again.

If a secret is believed compromised, skip the wait and cut the old secret
immediately — every active session is invalidated and users must re-sign.

Matching contract env vars for the indexer:

- `PONDER_TREASURY_POLICY_ADDRESS`
- `PONDER_ESCROW_CORE_ADDRESS`
- `PONDER_AGENT_ACCOUNT_ADDRESS`
- `PONDER_REPUTATION_SBT_ADDRESS`

Do not commit server secrets back into the repository.

## Failure modes

### API unhealthy

1. Check:
   ```bash
   docker compose logs --tail=100 backend
   ```
2. Confirm:
   - RPC connectivity (`DWELLER_RPC_URL`, `POLKADOT_RPC_URL`, or `RPC_URL`)
   - Redis connectivity
   - env file values
3. Redeploy backend if the code was just updated.

### Indexer unhealthy

1. Check:
   ```bash
   docker compose logs --tail=150 indexer
   ```
2. Confirm:
   - Postgres reachable
   - RPC reachable (`DWELLER_RPC_URL`, `POLKADOT_RPC_URL`, or `PONDER_RPC_URL_<chainId>`)
   - `DATABASE_URL` and `DATABASE_SCHEMA` correct

### TLS / domain issues

1. Check DNS records in Cloudflare
2. Confirm records are `DNS only` during direct Caddy issuance
3. Inspect:
   ```bash
   docker compose logs --tail=200 caddy
   ```

## Recommended operating habit

At minimum:

- take both Postgres and Redis backups before risky backend, auth, or schema changes
- use the scripted backend redeploy instead of ad-hoc commands
- verify `api`, `index`, and discovery immediately after deploys

## Release gate

When you want one promotion-style command instead of four separate checks, run:

```bash
cd /srv/agent-stack/app
./scripts/ops/check-release-readiness.sh testnet
```

This gate runs:

1. frontend tests
2. backend tests
3. `npm run build:site`
4. `npm run typecheck:indexer`
5. `./scripts/verify_deployment.sh <profile>`
6. `./scripts/ops/check-hosted-stack.sh`

Useful variants:

```bash
# If you are already on the VPS and only want the live hosted checks:
RUN_FRONTEND_TESTS=0 RUN_BACKEND_TESTS=0 RUN_SITE_BUILD=0 RUN_INDEXER_TYPECHECK=0 \
  ./scripts/ops/check-release-readiness.sh testnet

# If the stack is intentionally paused during a rehearsal:
ALLOW_PAUSED=1 ./scripts/ops/check-release-readiness.sh testnet
```

For the human-readable checklist that goes with this command, see
[docs/PRODUCTION_CHECKLIST.md](/Users/pascalkuriger/repo/Polkadot/docs/PRODUCTION_CHECKLIST.md).

## Observability

- `GET /metrics` on the backend exposes Prometheus text-format metrics:
  `http_requests_total`, `http_request_duration_ms`, `auth_failures_total`,
  `rate_limit_rejections_total`, `sse_active_connections`,
  `state_store_backend`. Leave `METRICS_BEARER_TOKEN` unset for same-network
  scrapers, or set it to a random token when `/metrics` is publicly reachable.
- Ponder's indexer server exposes:
  - `/health` — process is up and serving HTTP
  - `/ready` — historical indexing is complete
  - `/status` — latest indexed block number + timestamp per chain
- Sentry is opt-in. To enable on the backend:
  ```bash
  cd /srv/agent-stack/app/mcp-server
  npm install @sentry/node
  # then in backend.env:
  SENTRY_DSN=https://...
  SENTRY_ENVIRONMENT=production
  SENTRY_RELEASE=<git sha or tag>
  ```
  The error path only ships 5xx exceptions to Sentry; 4xx auth failures stay in
  logs + metrics.
- Frontend Sentry is runtime-configurable now. Set `sentryDsn` under
  `window.__AVERRAY_CONFIG__` in `frontend/index.html`; the app will
  auto-load the browser SDK from the default CDN URL. If you need to pin a
  different browser bundle, also set `sentryScriptUrl`.
- Structured logs are JSON on stdout with a per-request `requestId`. Filter with
  `docker compose logs backend | jq 'select(.requestId == "...")'`.
- For an external uptime runner or cron smoke check, use:
- For an external uptime runner or cron smoke check, use:
  ```bash
  cd /srv/agent-stack/app
  ./scripts/ops/check-hosted-stack.sh
  ```
  It verifies the public site, discovery manifest, operator app shell, API
  health, onboarding contract, indexer root, indexer readiness, and indexer
  status freshness. A non-zero exit should page someone if the stack is meant
  to be available.
- To turn that into an actual webhook-driven alert path, use:
  ```bash
  cd /srv/agent-stack/app
  ALERT_WEBHOOK_URL=https://your-alert-webhook \
  ALERT_SERVICE_NAME=averray-hosted-stack \
  ALERT_ENVIRONMENT=production-like \
  ./scripts/ops/check-hosted-stack-and-alert.sh
  ```
  It runs the same smoke check and POSTs a JSON alert payload to the webhook
  if the check fails.

## Monthly backup-restore drill

Verifying that backups are restorable is the only way to know they work. Run
this on the first of each month in a disposable target:

```bash
# 1. Grab the most recent dump
LATEST=$(ls -1t /srv/agent-stack/backups/postgres/*.sql.gz | head -1)

# 2. Spin up a throwaway Postgres on port 55432
docker run -d --name pg-restore-test \
  -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16

# 3. Pipe the dump in
gunzip -c "$LATEST" | docker exec -i pg-restore-test \
  psql -U postgres

# 4. Eyeball a table you care about
docker exec pg-restore-test psql -U postgres -c "\\dt"

# 5. Tear down
docker rm -f pg-restore-test
```

If the restore fails, check `docker compose logs postgres` for schema or
version drift; a failed drill is a P1 — fix it before the next risky change.

### Redis drill

Run the same kind of restore proof for Redis in a disposable container:

```bash
LATEST_REDIS=$(ls -1t /srv/agent-stack/backups/redis/*.rdb.gz | head -1)
TMPDIR=$(mktemp -d)

gunzip -c "$LATEST_REDIS" > "$TMPDIR/dump.rdb"

docker run -d --name redis-restore-test \
  -v "$TMPDIR:/data" redis:7 redis-server --dir /data --dbfilename dump.rdb

docker exec redis-restore-test redis-cli PING
docker exec redis-restore-test redis-cli DBSIZE
docker exec redis-restore-test redis-cli --scan "agent-platform:*" | head

docker rm -f redis-restore-test
rm -rf "$TMPDIR"
```

If `PING` fails or `DBSIZE` is unexpectedly zero, treat it like a broken
backup pipeline and fix it before the next risky deploy.

## Incident response

### Escalation ladder

1. **Detect** — alert from uptime monitor, Sentry, or user report.
2. **Stabilise** — if the protocol is moving funds in unexpected ways, call
   `setPaused(true)` from the pauser hot-key via the multisig/PolkadotJS
   extension. Pause is 1-signature (pauser role) and stops every mutating
   function on `EscrowCore` and `AgentAccountCore`. Value cannot move while
   paused.
3. **Triage** — pull the relevant `requestId` from logs, check `/metrics`
   for rate-limit or 5xx spikes, verify indexer isn't lagging (`/health` on
   the indexer service).
4. **Mitigate** — if code-level: redeploy with fix (auto-rollback on failed
   health). If config-level: edit `backend.env` and redeploy.
5. **Post-mortem** — file a note in the repo with: timeline, blast radius,
   root cause, prevention.

### Contact + roles

Fill these in as the signer set grows:

- Primary oncall: <you>
- Backup oncall: <TBD>
- Multisig signers: <TBD>
- External party auth (if any): <TBD>

For the fuller severity matrix, ownership model, and post-incident template,
see [docs/INCIDENT_RESPONSE.md](/Users/pascalkuriger/repo/Polkadot/docs/INCIDENT_RESPONSE.md).

### Commands you'll reach for

```bash
# Pause the protocol (hot-key pauser)
# From a machine with the pauser private key or PolkadotJS extension access:
cast send "$TREASURY_POLICY" "setPaused(bool)" true \
  --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"

# Unpause once the issue is resolved
cast send "$TREASURY_POLICY" "setPaused(bool)" false \
  --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"

# Force a rollback without health-check
SKIP_ROLLBACK=1 ./scripts/ops/redeploy-backend.sh  # leave broken build for inspection
git -C /srv/agent-stack/app checkout <known-good-sha>
docker compose --project-directory /srv/agent-stack up -d --build backend
```
