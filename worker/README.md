# Averray worker

This standalone Node 20+ ESM module adapts read-only Averray job definitions to
Agent Harness `TaskIntent` objects, drives the harness CLI as a black box, and
assembles verified GitHub PR evidence objects. It has no runtime dependencies
and is not a root npm workspace member.

The sandbox profile denies all network egress. The caller prepares the local
checkout before a run. Publishing a PR and sending the resulting evidence are
separate, approval-gated operations; this module stops at the verified object.

## Emit an intent

```sh
node bin/emit-intent.mjs examples/github-issue-job.json \
  --workspace /absolute/path/to/prepared/checkout
```

The command writes JSON to stdout. An unverifiable job still emits an intent,
but writes a warning to stderr and exits 3 so it cannot be treated as eligible
for automated submission.

## Gates

```sh
npm test
npm run gate:contract
npm run gate:integration
```

The latter two commands use `HARNESS_REPO` (default
`$HOME/repo/agent-harness`) and `HARNESS_BIN` (default
`$HARNESS_REPO/.venv/bin/harness`). The integration gate also requires Docker
and uses a fresh disposable Postgres container.

Before evidence crosses the external submission seam, the assembled object can
be checked with the public `POST /jobs/validate-submission` endpoint. This
module deliberately does not perform that write or any later publishing step.
