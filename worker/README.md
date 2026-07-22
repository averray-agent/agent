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

## Live smoke (operator-run, real model)

Scripted gates cannot reproduce a real model's quirks, so the first live-model
run is an operator ceremony. The model key is read only from the environment of
the terminal that runs the script, is passed only to the harness process, and is
never printed or written anywhere.

In the terminal that will run the smoke (zsh):

```sh
read -s 'k?key: ' && export HARNESS_MODEL_API_KEY="$k" && unset k
export HARNESS_MODEL_REF=<executor-model-ref>
# optional; the openai-compatible adapter defaults to https://ollama.com/v1
export HARNESS_MODEL_BASE_URL=<https://.../v1>
npm run smoke:live
```

Stage 1 (what the script does): a **trusted, self-created** fixture task on the
local provider — a tiny repo with an off-by-one bug the model must fix so
`node test.js` passes, with `test.js` broker-protected via `forbidden_paths`.
It provisions a disposable Postgres, validates and submits the intent through
the real durable runtime, waits for `outcome=completed`, and retains the patch,
verification report, and change summary in a printed tmp directory. The local
provider is acceptable here ONLY because the task is authored inside the script;
it has no isolation.

## Stage 2 — Docker sandbox (operator-run)

Real bounty jobs are adversarial input, so they must run in an isolated,
network-denied container, not the local provider. The `averray-worker` profile
already selects `provider: docker` + `egress: deny_all`; Stage 2 proves that path
end to end on a real, locally-built image.

The sandbox image is [`sandbox/Dockerfile`](sandbox/Dockerfile) — a login shell,
`sleep`, git (with `safe.directory`), Node, and pytest, matching the harness
provider's container contract (`docker run --network none … sleep infinity`, then
`docker exec … /bin/sh -lc "<cmd>"`). Build + load it locally (providers never
pull):

```sh
docker build -t averray-worker-sandbox:latest worker/sandbox
```

Two checks:

```sh
# Deterministic mechanism gate (no model key): runs the scripted dry-run on the
# docker provider and asserts the run really used it (environment_provider=docker)
# over --network none.
npm run gate:docker

# Real-model smoke: the same trusted off-by-one fixture as Stage 1, but inside the
# --network none sandbox. Same key hygiene as smoke:live; builds the image if
# missing and runs an isolation preflight first.
export HARNESS_MODEL_REF=<executor-model-ref>   # key already exported per above
npm run smoke:stage2
```

`smoke:stage2` self-verifies isolation two ways: an independent preflight
(`docker run --network none <image>` must fail to resolve DNS) and the harness's
own guarantee — it rejects any run whose container `NetworkMode` is not `none`,
so a completed docker run is proof. Green ends with `environment_provider=docker`
and `live_smoke=passed`.

For an actual Averray job, fetch it read-only with `GET /jobs/definition?jobId=…`,
prepare a local clone of `source.repo` as the workspace, and point the same
docker path at it. The claim/submit/PR-open steps remain outside this module
entirely.
