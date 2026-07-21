# PKT-AVGW-001 handback — Averray demand-side worker

## What was built

- Added a standalone, dependency-free Node 20+ ESM package in `worker/`, outside
  the root npm workspaces.
- Added the exact `averray-worker` harness profile under
  `worker/profiles/averray-worker/profile.yaml`: Docker by default, deny-all
  egress, direct execution, no network or external-write capability, and no
  learning writes.
- Added the pure bounty-to-`TaskIntent` adapter, JSON serializer, provenance
  labels, deterministic command/baseline acceptance, and explicit
  unverifiable-job warnings.
- Added the `emit-intent` file/stdin CLI with exit 3 for unverifiable work.
- Added the black-box `HarnessDriver` for submit, status polling, deliverables,
  and artifact retrieval, plus exported pure CLI-output parsers.
- Added the read-only Averray job-definition client. Its only request is
  `GET /jobs/definition?jobId=` with no authorization header.
- Added the verified GitHub PR evidence assembler. It requires a PR URL,
  refuses any report whose `passed` field is not exactly `true`, truthfully
  summarizes passing deterministic checks, and derives changed files from the
  patch.
- Added real-file unit fixtures, 19 unit tests, a real harness validation gate,
  and a reproducible Docker/Postgres scripted-runtime gate.

The worker stops at the verified evidence object. It contains no money-rail
client, authentication flow, payment credential handling, job claim, final job
submission, or PR-opening implementation. The separate harness repository was
read and executed only through its CLI and remains clone-clean.

## Decisions not covered by the packet

1. Public module entry point: `worker/src/index.js` re-exports the supported
   API and is named by `package.json#exports` — rationale: consumers should not
   need to depend on the internal file layout.
2. `HarnessDriver.artifactGet()` returns a `Buffer` without `outPath` and the
   supplied path with `outPath` — rationale: preserve raw artifact bytes while
   giving file-writing callers an unambiguous completion value.
3. `HarnessDriver.runToCompletion()` returns an empty deliverables object for
   `partial`, `failed`, `quarantined`, or `cancelled` terminal runs — rationale:
   the live CLI exposes deliverables only for completed runs, so the driver
   must not invent them or turn an already-observed terminal status into a
   second CLI error.
4. A passing verification report with zero `check_results` is described as
   having no deterministic checks reported — rationale: this is truthful for
   the packet's scripted empty-acceptance gate; mapped unverifiable jobs are
   independently blocked by the warning and exit-3 path.
5. `ciStatus` is omitted when the caller does not supply it and rejected when
   outside the schema enum — rationale: unknown evidence is not synthesized,
   while caller-supplied evidence must remain schema-valid.
6. The integration gate discovers a free loopback port unless
   `AVERRAY_WORKER_POSTGRES_PORT` is supplied — rationale: every run gets a
   dedicated database without colliding with other local harness work.
7. npm invokes the gate scripts with `sh` rather than relying on executable
   mode bits — rationale: clean-checkout reproduction is independent of local
   filesystem mode handling.

## Deviations

None.

## Gate environment

- Platform base: `284fbd9` (`origin/main`, PR #782), including packet commit
  `2cc79d0` (PR #783) in its ancestry.
- Harness kernel: `694f084d58b11c60db876c6c340315022c7b07b9`.
- Clean gate checkout: detached worktree at implementation commit `85f77aa`.
- Harness profile root during the real runtime gate: this checkout's
  `worker/profiles` via `HARNESS_PROFILES_ROOT`.
- Runtime database: fresh disposable `postgres:18` container on a dedicated
  loopback port.

## Gate output

### Unit — `cd worker && npm test`

```text
> @averray/worker@0.1.0 test
> node --test

✔ fetchJobDefinition performs one public read-only request (1.702125ms)
✔ fetchJobDefinition rejects HTTP failures (0.428041ms)
✔ emit-intent reads a file and emits deterministic JSON (69.92175ms)
✔ emit-intent emits unverifiable intent but exits 3 (71.209167ms)
✔ emit-intent reads job JSON from stdin (75.080542ms)
✔ parseStatusOutput reads the real key-value status shape (4.814875ms)
✔ terminal detection follows outcome presence rather than transient completed state (0.110167ms)
✔ parseDeliverablesOutput maps artifact types to URIs (0.878959ms)
✔ slugifyJobId produces a bounded harness id (1.031833ms)
✔ mapJobToTaskIntent produces the verified deterministic structure (3.968167ms)
✔ explicit mapping options override suggested defaults (0.621083ms)
✔ unverifiable jobs have empty acceptance and an eligibility warning (0.537625ms)
✔ serializeIntent returns round-trippable JSON (0.55475ms)
✔ workspacePath is mandatory (0.497ms)
✔ filesChangedFromPatch parses and deduplicates git diff headers (4.172083ms)
✔ assembleGithubPrSubmission creates truthful verified evidence (0.901292ms)
✔ assembler refuses absent PR evidence or failed verification (0.797708ms)
✔ assembler remains truthful when a passing report contains no deterministic checks (0.464583ms)
✔ assembler rejects an unknown CI status (0.557666ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 323.562
```

### Contract — generated intent through the real harness validator

Commands:

```sh
node bin/emit-intent.mjs examples/github-issue-job.json --workspace /tmp/x > /tmp/i.json
( cd ~/repo/agent-harness && HARNESS_PROFILES_ROOT="$OLDPWD/profiles" .venv/bin/harness validate /tmp/i.json )
```

Full validator output:

```text
task=github-averray-agent-agent-741 profile=averray-worker deliverables=3 acceptance=job-checks,no-regressions
budget=elapsed:0:30:00 model_tokens:2000000 tool_calls:400 children:1/1
```

Exit status: `0`.

### Integration — `cd worker && npm run gate:integration`

```text
> @averray/worker@0.1.0 gate:integration
> sh scripts/scripted-dry-run.sh

postgres_container=90238be56171d949079745123fd2e34e73cddc7eacafa6f8fb1ba0f419588ca5
postgres_port=60550
postgres_ready=true
applied 0001_domain_events.sql
applied 0002_runs.sql
applied 0003_episodes.sql
applied 0004_safety_event.sql
applied 0005_routing_attempts.sql
applied 0006_memory_records.sql
applied 0007_memory_retrieval.sql
worker_ready=true
submitted_run_id=b60d2a8d-97df-4e8f-9323-f2f0856942b1
run_id=b60d2a8d-97df-4e8f-9323-f2f0856942b1
state=learning_queued
attempt=1
outcome=completed
outcome_reason=-
egress_policy=deny_all []
created_at=2026-07-21T14:56:21.130779+00:00
updated_at=2026-07-21T14:56:25.132372+00:00
verification_report artifact://sha256/14798e631855ec89036e33568024e9337e9c9a2cfa1359e7390b6c1e336d7cb8
verification_report={"check_results":[],"optional_failed":[],"passed":true,"protected_violations":[],"required_failed":[],"verdict":"completed"}
scripted_dry_run=passed
```

Exit status: `0`.

### Kernel clone hygiene after all gates

```text
$ git -C ~/repo/agent-harness status -sb
## main...origin/main
```

## Open questions

None.
