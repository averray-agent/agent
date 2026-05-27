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

- Primary on-call: <ops@averray.com>
- Backup on-call: <ops@averray.com>
- Contract owner signers: the three 2-of-3 signatories in
  [`deployments/testnet-multisig-owner.json`](../deployments/testnet-multisig-owner.json)
  are currently all hot dev keys (testnet posture). Mainnet adoption of
  hot / warm / cold custody tiers is a separate launch-readiness item
  tracked in [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md).
- Pauser operator: <ops@averray.com>
- External escalation path: empty. Intentionally not assigned — no
  audit firm or incident-response retainer is engaged yet. Update when
  that changes.

`ops@averray.com` is the operator alias that delivers to whoever is on
duty; primary on-call, backup on-call, and pauser operator all land in
the same inbox. The pauser role is `setPaused`-only per
[`THREAT_MODEL.md`](./THREAT_MODEL.md), so a compromised pauser key can
grief by pausing but cannot drain funds — sharing the inbox with on-call
is acceptable for the v1 posture.

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
3. CloudWatch alarms from the KMS/auth alarm stack in
   [`deploy/iac/cloudwatch/kms-signing-alarms.yaml`](../deploy/iac/cloudwatch/kms-signing-alarms.yaml)
4. Human reports from operators or counterparties

Recommended webhook env for the smoke-alert wrapper:

```bash
ALERT_WEBHOOK_URL=<Slack Incoming Webhook URL from the operator alert channel>
ALERT_SERVICE_NAME=averray-hosted-stack
ALERT_ENVIRONMENT=production-like
```

The canonical v1 alert destination is a Slack Incoming Webhook for the operator
channel. `ALERT_WEBHOOK_URL` stays blank in `deploy/backend.env.template` until
the Slack webhook and production 1Password item exist. This keeps normal deploys
green while alert delivery is still a proof item: `op inject` resolves every
active secret reference in the template and fails closed if an optional item is
missing. Once provisioned, render the URL into the scheduler environment that
runs `check-hosted-stack-and-alert.sh`, then capture the deliberate failure proof.

To prove alert delivery without adding a synthetic endpoint, run a deliberate
hosted smoke failure:

1. Temporarily tighten the production scheduler env to
   `INDEXER_MAX_STALENESS_SEC=1`.
2. Run `./scripts/ops/check-hosted-stack-and-alert.sh`.
3. Confirm the Slack operator channel receives the structured smoke-failure
   alert.
4. Restore the previous staleness value and re-run the hosted smoke green.

Capture the Slack delivery confirmation in the observability evidence bundle
with Metrics auth and the Sentry/logging decision.

---

## 4. KMS and auth alerts

The KMS/auth alarm bundle separates the blockchain mutation signer from the JWT
signer. Treat the alarm name prefix as the first routing clue:

- `blockchain-kms-*`: chain mutations, escrow, settlement, and treasury actions
  may be unable to sign or may be signing unexpectedly often.
- `jwt-kms-*`: SIWE, refresh, service-token issuance, and admin JWT minting may
  be unable to issue ES256 tokens.
- `auth-*`: the backend is seeing anomalous authentication failures or refresh
  replay detection.

### Alarm meanings

| Alarm | Severity | Meaning | First move |
|---|---|---|---|
| `*-kms-sign-error` | P1 | `kms:Sign` returned a CloudTrail error for that signer key. | Check CloudTrail event details, backend `kms.sign.duration` failure logs, and whether the key/role/region changed. |
| `*-kms-access-denied` | P1 | KMS rejected the caller. This usually means a broken Roles Anywhere session, revoked permission, wrong key ARN, or policy drift. | Verify the shared-config profile and role session, then compare the effective IAM/KMS policy to the last known-good deployment. |
| `*-kms-sign-spike` | P2 unless value movement is suspicious, then P1 | Sign call volume exceeded the baseline-derived 5-minute threshold. | Compare against expected worker traffic and recent deploys; pause mutating flows if the blockchain signer spike does not match known activity. |
| `auth-failure-spike` | P2 | 401/403 responses exceeded the baseline-derived 5-minute threshold. | Inspect `http.error` logs by `code`, especially `bad_signature`, `token_expired`, `token_revoked`, and `missing_capability`. |
| `auth-refresh-replay-detected` | P1 | Strict refresh-token replay detection fired. Treat as credential theft until disproven. | Revoke the affected refresh chain if not already revoked, identify wallet/session, and rotate any exposed operator credential. |

### First debug commands

```bash
aws cloudwatch describe-alarms \
  --region eu-central-2 \
  --alarm-name-prefix averray-testnet

aws logs filter-log-events \
  --region eu-central-2 \
  --log-group-name /averray/testnet/cloudtrail/kms \
  --filter-pattern '{ ($.eventSource = "kms.amazonaws.com") && ($.eventName = "Sign") }'

aws logs filter-log-events \
  --region eu-central-2 \
  --log-group-name /averray/testnet/backend \
  --filter-pattern '{ $.event = "kms.sign.duration" }'

aws logs filter-log-events \
  --region eu-central-2 \
  --log-group-name /averray/testnet/backend \
  --filter-pattern '{ ($.msg = "http.error") && (($.status = 401) || ($.status = 403)) }'
```

If the blockchain signer alarm coincides with unexpected value movement, pause
first and debug second. If the JWT signer is failing, expect wallet login,
refresh, admin minting, and service-token issuance to fail while existing valid
tokens continue until expiry.

---

## 5. First 15 minutes

### If value movement looks wrong

1. Pause immediately using the pauser key.
2. Confirm `paused()` on-chain.
3. Freeze deploy activity until ownership is aligned on the next move.

### If the service is down or degraded

1. Run:
   ```bash
   cd /srv/agent-stack/app
   ./scripts/ops/check-hosted-stack.sh

   # If the operator app is deliberately behind browser auth and no app-shell
   # credentials are available in this shell:
   APP_ALLOW_PROTECTED_SHELL=1 ./scripts/ops/check-hosted-stack.sh

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

## 6. Response matrix

| Symptom | Severity | First move | Likely owner |
|---|---|---|---|
| Unexpected fund movement | P1 | Pause | Pauser + owner signer |
| `api.averray.com/health` failing | P2 | Check backend logs, roll back if recent deploy | Primary on-call |
| `index.averray.com/ready` failing | P2 | Check indexer logs/status, roll back or widen readiness window | Primary on-call |
| Public site/app shell failing | P2 | Check Caddy + static mounts | Primary on-call |
| Async XCM requests stuck in `pending` | P2 | Check watcher status, inspect `/xcm/request`, and rehearse manual finalize if needed | Primary on-call |
| Blockchain KMS signer error or access denied | P1 | Pause if value movement is suspicious; inspect CloudTrail + backend signer logs | Primary on-call + pauser |
| JWT KMS signer error or access denied | P1 | Inspect CloudTrail + backend signer logs; expect auth issuance failures | Primary on-call |
| KMS sign call spike | P2/P1 | Compare against expected traffic; pause mutating flows if unexplained | Primary on-call |
| Refresh replay detected | P1 | Revoke affected chain/session, identify exposure source | Primary on-call |
| `/content/:hash` unexpectedly 404s after Redis loss/restore | P2 | Dry-run the content recovery replay log, then apply if clean | Primary on-call |
| Redis restore drill fails | P1 | Treat as backup failure; stop risky deploys | Primary on-call |
| Smoke check drift only | P3 | Fix docs/config/runtime mismatch | Repo owner |

---

## 7. Rollback guidance

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

## 8. Post-incident note

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

## 9. Minimum “ready for prod” bar

Before calling the stack truly production-ready:

- [x] Primary and backup on-call are named
- [ ] A live alert webhook is configured
- [ ] `check-hosted-stack-and-alert.sh` is running from an external scheduler
- [ ] Pause path has been rehearsed recently
- [ ] Rollback path has been rehearsed recently
