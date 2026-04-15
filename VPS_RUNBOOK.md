# VPS Runbook

This runbook captures the production-like setup currently running on the OVH VPS for `averray.com`.

## Stack layout

- Stack root on server: `/srv/agent-stack`
- Repo checkout: `/srv/agent-stack/app`
- Compose file: `/srv/agent-stack/docker-compose.yml`
- Infra services:
  - `agent-postgres`
  - `agent-redis`
  - `agent-caddy`
- App services:
  - `agent-backend`
  - `agent-indexer`

## Public endpoints

- Discovery: [https://averray.com/.well-known/agent-tools.json](https://averray.com/.well-known/agent-tools.json)
- App: [https://app.averray.com](https://app.averray.com)
- API: [https://api.averray.com](https://api.averray.com)
- Indexer: [https://index.averray.com](https://index.averray.com)
- Gas sponsor health: [https://api.averray.com/gas/health](https://api.averray.com/gas/health)

## Quick health checks

Run these on the VPS:

```bash
cd /srv/agent-stack
docker ps
curl -fsS https://api.averray.com/health
curl -fsS https://api.averray.com/gas/health
curl -fsS https://index.averray.com/
curl -fsS https://averray.com/.well-known/agent-tools.json
```

Expected signals:

- API health returns `status: ok`
- Gas health returns Pimlico status or a clean disabled mode
- Indexer root returns `status: ok`
- Discovery manifest returns JSON with `baseUrl` set to `https://api.averray.com`

## Redeploy flows

### Frontend-only changes

Frontend files are mounted directly into Caddy, so a repo pull is enough:

```bash
cd /srv/agent-stack/app
git pull
```

Hard refresh the browser after pulling.

### Backend changes

Use the scripted flow from the repo checkout:

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-backend.sh
```

This will:

1. fast-forward the repo to `origin/main`
2. rebuild `agent-backend`
3. hit the live API health endpoint

### Remote hosted-stack smoke test

From the repo checkout:

```bash
cd /srv/agent-stack/app/mcp-server
REMOTE_E2E_BASE_URL=https://api.averray.com \
REMOTE_E2E_WALLET=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519 \
npm run demo:e2e:remote
```

This creates a unique remote job, runs the full claim/submit/verify flow, and confirms the session lands in hosted history.

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

### Restore outline

Restore should be done deliberately and only after confirming the target file:

```bash
gunzip -c /srv/agent-stack/backups/postgres/<dump>.sql.gz | \
docker compose --project-directory /srv/agent-stack -f /srv/agent-stack/docker-compose.yml exec -T postgres \
  psql -U agent -d agent
```

Do not restore over a live database unless you mean to replace it.

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

Optional gas sponsorship vars for `/gas/*` endpoints:

- `PIMLICO_BUNDLER_URL`
- `PIMLICO_PAYMASTER_URL`
- `PIMLICO_ENTRY_POINT`
- `PIMLICO_SPONSORSHIP_POLICY_ID`
- `PIMLICO_CHAIN_ID`

Do not commit server secrets back into the repository.

## Failure modes

### API unhealthy

1. Check:
   ```bash
   docker compose logs --tail=100 backend
   ```
2. Confirm:
   - RPC connectivity
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
   - RPC reachable
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

- take a Postgres backup before risky backend or schema changes
- use the scripted backend redeploy instead of ad-hoc commands
- verify `api`, `index`, and discovery immediately after deploys
