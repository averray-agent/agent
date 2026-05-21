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
