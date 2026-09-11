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

The v1 alert destination is a Slack Incoming Webhook for the operator channel.
The `Hosted Observability Proof` workflow does not read `ALERT_WEBHOOK_URL`
from a GitHub secret: it SSHes to the VPS, runs
`scripts/ops/collect-live-observability-proof.sh`, and that wrapper verifies
the durable live-network selector plus public chain ID before selecting
`/run/agent-stack/backend.env` (testnet) or
`/run/agent-stack-mainnet/backend.env` (mainnet). The collector reads only the
selected render before calling
`check-hosted-stack-and-alert.sh`. Keep the webhook in the `prod-backend`
or `mainnet-backend` 1Password vault so the matching VPS backend service
account can render it at deploy/boot time.

Operator setup before running the proof:

1. Pick the Slack destination channel for hosted smoke failures. The workflow
   input defaults the evidence label to `ops-alerts`; if Pascal chooses another
   channel, pass that exact channel name in the `alert_channel` input.
2. Create a Slack Incoming Webhook for that channel.
3. Store the webhook URL at `op://prod-backend/alert-webhook-url/url`.
4. Redeploy or re-render the selected VPS backend env so its runtime file
   contains `ALERT_WEBHOOK_URL`.
5. Run the `Hosted Observability Proof` workflow in a separate proof step; it
   sends one deliberate hosted smoke failure and records the channel-visible
   correlation id in the sanitized observability artifact.

To prove alert delivery without adding a synthetic endpoint, run a deliberate
hosted smoke failure:

1. Temporarily tighten the production scheduler env to
   `INDEXER_MAX_STALENESS_SEC=1` (the sync-liveness budget; it runs on every
   smoke regardless of `CHECK_INDEXER`).
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

### Indexer sync stall from a provider block hole

Seen 2026-09-10 21:37Z → 2026-09-11 08:00Z on mainnet. Recognise it by the
combination: `index.averray.com/health` **200**, `/ready` **503**, `/status`
block timestamp not advancing, backend `/health` warning
`indexer_stalled` (critical; `indexer_lagging` alone is also what a schema
replay looks like — the difference is whether `/status` moves), hosted smoke
failing at "Indexer sync is stalled" (or, before this runbook, at "CreditPool
door did not return the wallet's L1/L2/L3 debt fields"), and indexer logs
carrying `RpcProviderError: Inconsistent RPC response data … 'block.transactions'
array does not contain a transaction matching that 'transactionIndex'` retried
with growing `retry_delay`, then Postgres `terminating connection due to
idle-in-transaction timeout`.

Cause: one RPC provider served a block whose header says transactions ran
(`gasUsed` and `logsBloom` non-zero) with an EMPTY `transactions` array —
its receipt store has a gap for that block, so it also answers `eth_getLogs`
with no logs for it and `eth_getTransactionReceipt` with `null`. Ponder's
`fallback` transport mixed that provider's block with another provider's logs,
rejected the pair, and retried inside one Postgres transaction until the
connection was killed. The compose healthcheck only probes `/health` (process
liveness), so nothing restarted it.

**Reproduce against the provider (report these three calls to them):**

```bash
BLOCK=0x138d4e6   # mainnet 20501734, 2026-09-10T21:12:48Z
TX=0xa432e1b35eaf2ee9a21d13edb729e78210a5ec508c264de52d277fa7d3f19030
for URL in https://services.polkadothub-rpc.com/mainnet/ https://eth-rpc.polkadot.io/; do
  echo "== $URL"
  # 1. full block: hole provider → "transactions":[] although gasUsed=0x7191
  curl -sS "$URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$BLOCK\",true]}" \
    | jq -c '.result | {hash, gasUsed, txs: (.transactions | length)}'
  # 2. logs for the block: hole provider → [] ; healthy provider → 3 logs (txIndex 0x3)
  curl -sS "$URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$BLOCK\",\"toBlock\":\"$BLOCK\"}]}" \
    | jq -c '.result | map({logIndex, transactionIndex})'
  # 3. receipt: hole provider → null ; healthy provider → status 0x1, 3 logs
  curl -sS "$URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
    | jq -c '.result | if . == null then null else {status, transactionIndex, logs: (.logs | length)} end'
done
```

Both providers return the same block hash `0x2efe1d96…4d84cc`; on
2026-09-11T09:47Z the hole provider still answered `txs: 0` / `[]` / `null`
(the hashes-only form `eth_getBlockByNumber($BLOCK,false)` had by then
recovered the transaction hash — the receipt-backed views had not).

Two failure modes, both real on 2026-09-10/11:

- **Loud:** logs from provider A + block from provider B → Ponder inconsistency
  error → retry storm → idle-in-transaction kill → wedge.
- **Silent:** after the restart the primary answered the historical range
  `eth_getLogs` alone, so the three EscrowCore claim events of block 20501734
  (`JobClaimed`, `ClaimRetentionSnapshot`, `ClaimEconomicsLocked` for job
  `0x0620927a…`) were never indexed. Nothing errored.

Mitigation in `indexer/src/rpc-transport.ts`: a block answer with an empty
transaction list but non-zero `gasUsed`/`logsBloom` is rejected **per
provider** (viem's fallback tries the next URL), and every `eth_getLogs` is
asked of all configured providers, answering with the superset and logging
`[indexer-rpc] <url> omitted N log(s) present at <url>` naming the hole;
conflicting answers are refused rather than guessed. Grep `docker logs
agent-mainnet-indexer` for `[indexer-rpc]` to see which provider served a hole.

First moves:

1. `docker restart agent-mainnet-indexer` — the sync resumes from its
   checkpoint. Do this when `/status` is frozen and no schema replay is in
   progress; the hosted smoke and `indexer_stalled` name exactly that state.
2. If events may have been skipped (a `[indexer-rpc] … omitted` line, or a job
   whose on-chain state is ahead of the index), use the cache-reset runbook
   below. **A schema rotation alone does not repair a cached provider hole.**
3. Report the three calls above to the provider with the block hash. Keep at
   least two providers in `deploy/indexer.env.template`; a single provider
   leaves the transport with nothing to compare against.

### Cached replay versus a full refetch

Ponder has two layers: `DATABASE_SCHEMA` holds the app's derived tables;
the shared `ponder_sync` schema holds raw chain data and fetched intervals.
A new app schema re-runs indexing functions over that cache and fetches only
missing intervals. A provider's empty log answer can therefore remain cached
as complete through any number of app-schema rotations. A log saying
`Skipped fetching backfill JSON-RPC data (cache contains all required data)`
is not evidence of a fresh provider comparison.

Timing: **≈5 min from cache; a cache reset is a full refetch**, expected to take
hours, not minutes. Neither duration is a readiness guarantee. The backup RPC
enables cross-checking new fetches; it cannot retroactively repair cached data.
`RPC_BACKUP_URLS`/`DWELLER_RPC_URL` are not `PONDER_*` identity keys and do not
by themselves rotate the app schema. The current resolver also retains
`PONDER_RPC_URL_<chainId>` as a fallback; the explicit backup is pinned
independently of that compatibility alias.

### Operator runbook: reset raw cache AND use a fresh app schema

Run only after the reset PR has merged, at a quiet hour. This deliberately
removes **all** mainnet raw chain cache, not just block 20501734. Do not run it
as an automatic deploy or retention step.

1. Confirm the deployed mainnet template has Dweller primary and
   `RPC_BACKUP_URLS=https://eth-rpc.polkadot.io/`. On the VPS, resolve the actual
   database target without stopping anything or changing state:

   ```sh
   /srv/agent-stack/app/scripts/ops/indexer-sync-cache-reset.sh --print-target
   ```

   This reads `DATABASE_URL` from `/run/agent-stack-mainnet/indexer.env` without
   sourcing it, checks the host against `agent-postgres` addresses/aliases on a
   Docker network shared with `agent-mainnet-indexer`, and prints only host,
   container, user, dbname, port, and the fixed `ponder_sync` schema. It never
   prints the password. The script needs Node with `node:util.parseEnv`
   (Node 20.12+; tested on Node 22), Docker, and, for reset, flock.
   Take and verify a backup of **that printed database** using the PostgreSQL
   backup/restore procedure; do not assume its dbname or user from a plan/doc.
   Confirm no other process is indexing against this database.
2. On the VPS, stop the mainnet indexer, then run the operator-only script:

   ```sh
   docker stop agent-mainnet-indexer
   INDEXER_FRESH_SCHEMA=1 /srv/agent-stack/app/scripts/ops/indexer-sync-cache-reset.sh
   ```

   The flag acknowledges the full refetch; the script does not dispatch a
   workflow. It refuses
   without exactly `1`, with a running/uninspectable indexer, or while the
   production deploy/schema locks are held. It re-reads and prints the target
   under those locks, derives psql's user/dbname/port from `DATABASE_URL`, and
   drops only `ponder_sync` in that database through `agent-postgres`.
   **After SQL succeeds, while still holding both locks**, it removes and
   prints `/srv/agent-stack/.deploy-state/indexer.database-schema.mainnet`.
   Any next indexer deploy, automatic or dispatched, must then mint a fresh
   schema via `fresh_host_bootstrap`. App schemas, identity state, and testnet
   claims are not deleted. **SQL failure leaves the mainnet claim untouched.**
   A SQL error, including an already-missing cache, is a failure, not success.
3. Leave the indexer stopped. Immediately dispatch the fresh-schema deploy:

   ```sh
   gh workflow run deploy-production.yml -R averray-agent/agent \
     -f run_indexer=1 \
     -f indexer_fresh_schema=1 \
     -f wait_for_ready=0 \
     -f health_stability_sec=15 \
     -f smoke_check_indexer=0
   ```

   Do **not** manually restart the old container/app schema. An ordinary
   indexer deploy between reset and dispatch is now safe: the persisted claim
   is gone, so it cannot reuse the old app checkpoint. The explicit fresh-schema
   workflow input is an additional safeguard, not the only protection against
   that race. If SQL succeeds but claim removal fails, treat the reset as failed:
   keep the indexer stopped and clear that claim before any deploy. If the
   reset or deployment fails, inspect the failure,
   and resume the paired recovery deliberately; do not blindly retry or treat
   rollback to the old app schema as repaired evidence. A database backup is
   the recovery path for the deleted cache, but restoring it restores the hole.
4. Expect a full historical refetch from **18,647,521** through both providers.
   While catching up, `/ready` remains staged and `/health` should be 200 once
   the replacement starts; the `/credit` receipt graph reports `indexer_stale`.
   Watch `/status` advance, not just container health. The existing hosted
   sync-liveness smoke remains enabled and unchanged; a stalled head is not a
   normal full-refetch condition.
5. After catch-up, query `jobEvents` for job
   `0x0620927a89b58abf91831d8a83efd5de2d78877f5b00af1cc88c7b569aae9481` and
   confirm all three claim events at **20501734**. Capture that response plus
   the `docker logs agent-mainnet-indexer` line
   `[indexer-rpc] … omitted 3 log(s) … 20501734` naming Dweller. These are the
   incident's repair evidence, not just a green readiness check. If the
   provider has since repaired its hole, record the changed provider answers
   explicitly rather than claiming an omission log was observed.

A hole shared by both providers still escapes the comparison. The periodic
two-provider completeness audit in `THREAT_MODEL.md` remains a follow-up.

---

## 6. Response matrix

| Symptom | Severity | First move | Likely owner |
|---|---|---|---|
| Unexpected fund movement | P1 | Pause | Pauser + owner signer |
| `api.averray.com/health` failing | P2 | Check backend logs, roll back if recent deploy | Primary on-call |
| `index.averray.com/ready` failing | P2 | Check indexer logs/status, roll back or widen readiness window | Primary on-call |
| `/status` frozen while `/health` is 200 (`indexer_stalled`, smoke "Indexer sync is stalled") | P2 | Restart for a frozen checkpoint; for a cached provider hole, pair cache reset with a fresh app schema — see §5 | Primary on-call |
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

## 9. Evidence gate

Capture a redacted rehearsal artifact before closing the roadmap's incident
response row. Validate it with:

```bash
node scripts/ops/check-incident-response-proof.mjs \
  --file docs/evidence/incident-response-YYYY-MM-DD.json \
  --max-completed-age-hours 24 \
  --json
```

For mainnet readiness, add `--require-mainnet`. That requires the evidence to
name Polkadot Hub mainnet, use a dedicated-pauser validation command, and point
pause/unpause transaction proof at Polkadot Hub explorer URLs.

The artifact must use schema `incident-response-proof-v1` and include:

- `polkadotDocs`: must include `smart-contracts/explorers.md` and
  `smart-contracts/for-eth-devs/accounts.md`.
- `contacts`: primary/backup on-call, pauser operator, and either an engaged
  external escalation contact or an explicit `not_engaged_v1` fallback.
- `severityDrills`: P1 acknowledge <=5 minutes with owner engaged, P2
  acknowledge <=15 minutes and mitigate/rollback <=60 minutes, P3 same-day
  triage.
- `alertDelivery`: `check-hosted-stack-and-alert.sh` ran, a deliberate failure
  reached the operator channel, the webhook value is redacted, and the hosted
  smoke returned green after restore.
- `pauseFlow`: evidence validated by
  `check-pauser-rehearsal-evidence.mjs`, live pause/unpause observed, final
  paused state false, and both pause/unpause tx hashes plus explorer URLs.
- `rollbackRehearsal`: backend, indexer, and frontend rollback paths exercised
  through their component redeploy scripts with health gates observed.
- `escalation`: primary/backup acknowledgements, owner signer reachability, and
  a durable handoff record.
- `postIncidentRecord`: timeline, blast radius, root cause, detection review,
  prevention change, resume criteria, and no secrets.
- `guardrails`: no private keys, raw webhooks, JWTs, provider keys, direct fund
  movement claims, or leftover paused state.

This validator is offline and read-only. It never sends alerts, pauses
contracts, calls chain RPC, or rolls back services.

---

## 10. Minimum “ready for prod” bar

Before calling the stack truly production-ready:

- [x] Primary and backup on-call are named
- [ ] A live alert webhook is configured
- [ ] `check-hosted-stack-and-alert.sh` is running from an external scheduler
- [ ] Pause path has been rehearsed recently
- [ ] Rollback path has been rehearsed recently
- [ ] A dated `incident-response-proof-v1` artifact validates with
  `check-incident-response-proof.mjs`
