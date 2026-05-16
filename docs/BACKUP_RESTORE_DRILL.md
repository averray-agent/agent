# Backup Restore Drill

Operator runbook for the **monthly restore-rehearsal** required by
[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §2 ("Data
durability"). Confirms that the most-recent Postgres and Redis backups
are actually usable, without touching production data.

This doc is the rehearsal procedure. For the destructive restore-
against-production outline (and the approval gate), see
[`VPS_RUNBOOK.md`](../VPS_RUNBOOK.md) §Backups. **Do not run the
production restore outline as part of this drill.**

## When to run

- Monthly, on a calendar reminder.
- After any change that affects backup contents shape: Postgres
  version bump, Redis config change, new container layout, new
  storage backend.
- After any incident where a restore was avoided only because the
  hot system was still up.

## What "passing" looks like

A successful drill produces three pieces of recorded evidence:

1. The readiness check is green on the production stack:
   `./scripts/ops/check-backup-readiness.sh --json` reports
   `overallStatus: "ok"` with both `postgres` and `redis` components
   `ok` and ages well below the threshold.
2. The most recent Postgres backup restores cleanly into a
   throwaway Postgres container, and a quick read query against a
   small representative table returns the expected row count.
3. The most recent Redis snapshot restores cleanly into a throwaway
   Redis container, and `KEYS *` (or a more conservative
   `DBSIZE`) returns roughly the count recorded at backup time.

All three are written into the operator log for the month with the
backup-file timestamps quoted.

## Pre-drill checklist

Before running the drill:

- [ ] Confirm you are operating against the *production* backup
  directory only as a *read source*. The drill restores into a local
  disposable target — never the production database or Redis service.
- [ ] Confirm `docker compose` is available locally and you can pull
  the matching Postgres and Redis images.
- [ ] Confirm `MAX_AGE_HOURS` for the readiness check matches the
  documented backup cadence (default 26h for daily backups). If the
  cadence has changed, update the production checklist before
  proceeding.

## Drill steps

### 1. Run the readiness check

On the VPS, against the live backup directory:

```bash
sudo -u <ops-user> /srv/agent-stack/app/scripts/ops/check-backup-readiness.sh --json \
  > /tmp/backup-readiness-$(date +%Y%m%d).json

cat /tmp/backup-readiness-$(date +%Y%m%d).json
```

Required: `overallStatus: "ok"`, both components `status: "ok"`, both
`ageSeconds` below `maxAgeHours * 3600`. If the check fails, stop and
fix the backup cadence before proceeding — running a drill against a
stale backup proves nothing.

Record the backup file paths the check selected; those are the files
the drill will restore.

### 2. Copy the selected backups to a workstation or a disposable VM

```bash
mkdir -p /tmp/backup-drill && cd /tmp/backup-drill

scp ops-vps:/srv/agent-stack/backups/postgres/agent-<TS>.sql.gz .
scp ops-vps:/srv/agent-stack/backups/redis/redis-<TS>.rdb.gz .
```

Operate on **copies**. Never edit, decompress in place, or rename the
files in the live backup directory.

### 3. Restore Postgres into a throwaway container

```bash
docker run -d --name drill-postgres \
  -e POSTGRES_USER=agent \
  -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_DB=agent \
  postgres:16

# Wait for the container to be ready
until docker exec drill-postgres pg_isready -U agent >/dev/null 2>&1; do
  sleep 1
done

gunzip -c agent-<TS>.sql.gz | docker exec -i drill-postgres \
  psql -U agent -d agent

# Spot-check a representative row count
docker exec drill-postgres psql -U agent -d agent \
  -c "select count(*) from submissions;"
```

Required: the restore exits cleanly and the row count is within a
reasonable band of the production count (record both).

Cleanup: `docker rm -f drill-postgres`.

### 4. Restore Redis into a throwaway container

```bash
mkdir -p /tmp/backup-drill/redis-data
gunzip -c redis-<TS>.rdb.gz > /tmp/backup-drill/redis-data/dump.rdb

docker run -d --name drill-redis \
  -v /tmp/backup-drill/redis-data:/data \
  redis:7

# Wait for Redis to load the RDB
sleep 2
docker exec drill-redis redis-cli DBSIZE
```

Required: the container starts without errors, `DBSIZE` returns a
key count within a reasonable band of the production count.

Cleanup: `docker rm -f drill-redis`.

### 5. Record the drill in the operator log

A successful drill writes one line to the operator log naming:

- Date of the drill.
- The two backup file paths used (postgres + redis).
- Ages reported by the readiness check.
- Row count from the Postgres spot-check.
- Key count from the Redis DBSIZE check.
- Operator name and signature (initials).

This is the evidence that closes the `PRODUCTION_CHECKLIST.md` line
"The monthly restore drill has been run at least once on the current
stack shape."

## What the drill does NOT do

- It does **not** restore over the production database or Redis.
- It does **not** verify behavioral parity (the restored snapshot may
  be missing the last ≤ 26h of writes; that's expected for a
  daily-backup cadence).
- It does **not** validate point-in-time recovery (we don't run WAL
  archiving today; the drill is for whole-snapshot recovery only).
- It does **not** authorize a real restore. See the approval gate in
  [`VPS_RUNBOOK.md`](../VPS_RUNBOOK.md) §Backups for the destructive
  path.

## Approval gate for a real production restore

A drill restores into a disposable container and needs no approval
beyond the operator running it. A **production restore** — replacing
the live Postgres or Redis snapshot — is a destructive operation and
requires:

1. **Named operator on the keyboard.** Production restore is not
   automated and is never run from CI or a workflow.
2. **A second human acknowledgment** before any `psql ... <` or any
   `cp /restore/dump.rdb /data/dump.rdb` command runs. The
   acknowledgment lives in the incident channel and quotes:
   - The exact backup file path being restored.
   - The reason (incident reference, ticket, or migration window).
   - The expected window of data loss (gap between backup and now).
   - The agreed rollback plan if the restore makes things worse.
3. **Maintenance window posted** to the operator channel before the
   `docker compose stop backend` step.
4. **Post-restore verification logged**: `/health` returns 200, basic
   smoke check passes, recent rows visible in the relevant tables.

The destructive restore commands themselves live in
[`VPS_RUNBOOK.md`](../VPS_RUNBOOK.md) §"Postgres restore outline" and
§"Redis restore outline". Those sections deliberately omit any
"just-run-this-one-liner" framing — every step is explicit, and the
restore is intended to be hand-typed under the approval gate above,
not pasted from a script.
