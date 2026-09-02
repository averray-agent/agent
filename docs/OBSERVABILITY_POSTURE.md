# Observability Posture

This document records the current v1 launch posture for the P0
`Sentry/logging decision` gate.

## Current Decision

- Backend Sentry is **optional and deferred** for v1 launch unless an operator
  configures a project DSN before RC1.
- Backend 5xx errors are always captured through the structured JSON logger,
  even when Sentry is not configured or `@sentry/node` is not installed.
- Frontend Sentry is **deferred for v1**. The operator app should rely on
  visible API errors, request IDs, and backend logs for launch operations.
- `LOG_LEVEL=info` remains the production default in
  [`deploy/backend.env.template`](../deploy/backend.env.template).

## Backend Behavior

The backend creates a pino-style JSON logger through
[`mcp-server/src/core/logger.js`](../mcp-server/src/core/logger.js). Each log
line includes `ts`, `level`, `name`, `msg`, and any contextual fields such as
`requestId`.

[`mcp-server/src/core/observability.js`](../mcp-server/src/core/observability.js)
wraps optional Sentry capture:

- If `SENTRY_DSN` is unset, `captureException` and `captureMessage` write to
  structured logs.
- If `SENTRY_DSN` is set but `@sentry/node` is unavailable, the backend logs
  `observability.sentry_unavailable` and keeps serving.
- If Sentry is enabled successfully, 5xx errors are sent to Sentry and still
  logged locally as `observability.captured_exception`.

## Proof Required Before Marking Proofed

To close the roadmap gate as `Proofed`, an operator must verify the active
deploy target exposes the structured logs:

```bash
# On the VPS or current production log surface:
sudo docker logs agent-backend --tail 50
```

Look for JSON log lines with `level`, `name`, and `msg`. If Sentry is enabled,
also verify `observability.sentry_ready` appears after backend startup. If
Sentry remains deferred, record that the log-only posture is intentional for
v1 and link this document from the launch notes.

For RC1, record the observability proof as a machine-readable artifact under
`docs/evidence/`, for example `docs/evidence/observability-2026-05-22.json`.
The artifact should cover metrics auth, alert delivery, and Sentry/logging
posture in one place:

The preferred hosted path is the `Hosted Observability Proof` GitHub Actions
workflow. It SSHes to the VPS, reads the rendered `/run/agent-stack/backend.env`
without printing secrets, proves the `/metrics` bearer gate, sends one
deliberate smoke-failure alert through the configured webhook, samples recent
backend structured logs, validates the sanitized evidence with
[`check-observability-proof.mjs`](../scripts/ops/check-observability-proof.mjs),
and uploads a 90-day artifact. It intentionally fails closed until both
`METRICS_BEARER_TOKEN` and `ALERT_WEBHOOK_URL` are present in the hosted
runtime environment.

Current live proof: workflow run `26594855907` on 2026-05-28 uploaded artifact
`hosted-observability-proof-26594855907`, with validation `status: "ok"`. The
artifact records unauthenticated `/metrics` `401`, authenticated `/metrics`
`200`, deliberate alert delivery to `ops-alerts` as
`github-observability-alert-26594855907-1`, and `log_only_deferred` Sentry
posture with a structured `http.response` line sampled from
`docker logs agent-backend --tail 200`.

For Slack incoming webhooks, the provider response does not include the Slack
message timestamp. In that case, use the workflow's channel-visible
`ALERT_CORRELATION_ID` as `alertDestination.messageId`; the alert payload
includes the same `correlationId` so an operator can find the delivered message.

```json
{
  "schemaVersion": "observability-proof-v1",
  "proofDate": "2026-05-22",
  "completedAt": "2026-05-22T18:30:00.000Z",
  "operator": {
    "name": "Pascal",
    "signature": "PK"
  },
  "target": {
    "environment": "production",
    "apiBaseUrl": "https://api.averray.com"
  },
  "metricsAuth": {
    "checkHostedStackRan": true,
    "command": "METRICS_BEARER_TOKEN=$METRICS_BEARER_TOKEN CHECK_METRICS_AUTH=1 ./scripts/ops/check-hosted-stack.sh",
    "unauthenticatedStatus": 401,
    "authenticatedStatus": 200,
    "observedAt": "2026-05-22T18:00:00.000Z"
  },
  "alertDestination": {
    "webhookConfigured": true,
    "deliberateFailureDelivered": true,
    "channel": "ops-alerts",
    "messageId": "github-observability-alert-123456789-1",
    "receivedAt": "2026-05-22T18:05:00.000Z",
    "failureMode": "Deliberate hosted smoke failure via local stub; alert payload included correlationId github-observability-alert-123456789-1."
  },
  "sentryLogging": {
    "decision": "log_only_deferred",
    "structuredLogsVisible": true,
    "logSurface": "docker logs agent-backend --tail 50",
    "observedLogLine": "{\"level\":\"info\",\"name\":\"averray-mcp\",\"msg\":\"http.listening\"}",
    "observedAt": "2026-05-22T18:10:00.000Z",
    "sentryReadyObserved": false,
    "deferredReason": "Backend Sentry intentionally deferred for v1; structured logs are the active launch surface."
  }
}
```

Do not paste bearer tokens, webhook URLs, API keys, or Sentry DSNs into this
artifact. Validate it before using it to close the P0 observability rows:

```bash
node scripts/ops/check-observability-proof.mjs \
  --file docs/evidence/observability-YYYY-MM-DD.json \
  --max-completed-age-hours 30 \
  --json
```

The freshness flag is intentionally explicit: it lets older artifacts remain
auditable while preventing stale evidence from being reused as current launch
proof.
