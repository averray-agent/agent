# Incident Response

This playbook turns the current smoke checks, deploy gates, and control-plane
rehearsals into an actual operator response model.

Use it together with:

- [VPS_RUNBOOK.md](../VPS_RUNBOOK.md) for host-level commands
- [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for owner/pauser actions
- [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) for promotion gates
- [CONTENT_RECOVERY_RUNBOOK.md](./CONTENT_RECOVERY_RUNBOOK.md) for
  `/content/:hash` recovery from the append-only JSONL log

---

## 1. Ownership

Fill these in before calling the system production-ready:

- Primary on-call: `<name / handle>`
- Backup on-call: `<name / handle>`
- Contract owner signers: `<hot / warm / cold mapping>`
- Pauser operator: `<name / handle>`
- External escalation path: `<vendor, consultant, or empty>`

If these are blank, you do not have incident ownership yet.

---

## 2. Severity levels

### P1 — Funds or trust at risk

Examples:

- unexpected value movement
- unauthorized admin action
- on-chain pause needed immediately
- persistent auth bypass or signer compromise

Target response:

- acknowledge immediately
- pause if needed
- human owner engaged immediately

### P2 — Live service degraded

Examples:

- API unhealthy
- indexer stale or not ready
- public app/site unavailable
- hosted smoke check failing

Target response:

- acknowledge within 15 minutes
- mitigate or roll back within 60 minutes

### P3 — Partial or low-risk issue

Examples:

- one public surface stale
- non-critical doc/config drift
- noisy but non-user-visible background failures

Target response:

- same day during active support hours

---

## 3. Alert sources

The minimum useful alert set is:

1. External uptime / cron runner hitting:
   - `./scripts/ops/check-hosted-stack-and-alert.sh`
2. Backend Sentry for 5xx exceptions
3. Human reports from operators or counterparties

Recommended webhook env for the smoke-alert wrapper:

```bash
ALERT_WEBHOOK_URL=https://your-alert-webhook
ALERT_SERVICE_NAME=averray-hosted-stack
ALERT_ENVIRONMENT=production-like
```

The webhook can point at Slack, Discord, PagerDuty Events API, or any internal
relay that accepts JSON POSTs.

---

## 4. First 15 minutes

### If value movement looks wrong

1. Pause immediately using the pauser key.
2. Confirm `paused()` on-chain.
3. Freeze deploy activity until ownership is aligned on the next move.

### If the service is down or degraded

1. Run:
   ```bash
   cd /srv/agent-stack/app
   ./scripts/ops/check-hosted-stack.sh

   # If an admin JWT is available, include async XCM operator status too:
   ADMIN_JWT='<admin-jwt>' ./scripts/ops/check-hosted-stack.sh
   ```
2. Check:
   ```bash
   cd /srv/agent-stack
   docker compose logs --tail=100 backend
   docker compose logs --tail=100 indexer
   docker compose logs --tail=100 caddy
   ```
3. If the bad state follows a fresh deploy, use the known-good rollback path.

---

## 5. Response matrix

| Symptom | Severity | First move | Likely owner |
|---|---|---|---|
| Unexpected fund movement | P1 | Pause | Pauser + owner signer |
| `api.averray.com/health` failing | P2 | Check backend logs, roll back if recent deploy | Primary on-call |
| `index.averray.com/ready` failing | P2 | Check indexer logs/status, roll back or widen readiness window | Primary on-call |
| Public site/app shell failing | P2 | Check Caddy + static mounts | Primary on-call |
| Async XCM requests stuck in `pending` | P2 | Check watcher status, inspect `/xcm/request`, and rehearse manual finalize if needed | Primary on-call |
| `/content/:hash` unexpectedly 404s after Redis loss/restore | P2 | Dry-run the content recovery replay log, then apply if clean | Primary on-call |
| Redis restore drill fails | P1 | Treat as backup failure; stop risky deploys | Primary on-call |
| Smoke check drift only | P3 | Fix docs/config/runtime mismatch | Repo owner |

---

## 6. Rollback guidance

### Backend

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-backend.sh
```

The script already performs health-gated rollback.

### Indexer

```bash
cd /srv/agent-stack/app
./scripts/ops/redeploy-indexer.sh
```

The script already performs health/readiness-gated rollback.

### Async XCM lane

If async strategy requests stop progressing:

```bash
curl -sS https://api.averray.com/admin/status \
  -H "authorization: Bearer $ADMIN_JWT"

curl -sS "https://api.averray.com/xcm/request?requestId=$REQUEST_ID" \
  -H "authorization: Bearer $ADMIN_JWT"
```

If the watcher is healthy but the request still needs manual operator
intervention, use the current-lane rehearsal helper from
[ASYNC_XCM_STAGING.md](./ASYNC_XCM_STAGING.md):

```bash
API_URL=https://api.averray.com \
ADMIN_JWT="$ADMIN_JWT" \
REQUEST_ID="$REQUEST_ID" \
node scripts/ops/exercise-async-xcm-request.mjs --mode finalize --status succeeded
```

### Static surfaces

If only the public site or app shell regressed:

```bash
cd /srv/agent-stack/app
git checkout <known-good-sha>
cd /srv/agent-stack
docker compose restart caddy
```

---

## 7. Post-incident note

Every P1/P2 should leave behind a short note containing:

- timeline in UTC
- user-visible blast radius
- root cause
- why the existing checks did or did not catch it
- permanent prevention change

If the incident required a pause, include:

- who paused
- when unpaused
- what criteria were used to resume

---

## 8. Minimum “ready for prod” bar

Before calling the stack truly production-ready:

- [ ] Primary and backup on-call are named
- [ ] A live alert webhook is configured
- [ ] `check-hosted-stack-and-alert.sh` is running from an external scheduler
- [ ] Pause path has been rehearsed recently
- [ ] Rollback path has been rehearsed recently
