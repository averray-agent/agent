# INCIDENT — eight backend crashes on 2026-09-24 (fixed by #1401, live 2026-09-25)

Recorded 2026-09-25 by Claude, after the fix was deployed (`a66c23de`, Deploy
Production run 36116911407). Kept off the public branch until then.

## What happened

Between 12:10 and 16:04 UTC on 2026-09-24 the mainnet backend process exited eight
times and Docker restarted it each time (`RestartCount 8`, container created
2026-09-22 21:51Z). Each exit took the API down for about six seconds and reset the
in-memory job catalogue. The hosted worker canary's `GET /auth/session failed with
502` at 12:10:14Z was the first one.

Every exit printed the same unhandled rejection:

```
NotFoundError: Unknown job: pr-pmxt-dev-pmxt-2418
    at JobCatalogService.requireJob (src/core/job-catalog-service.js:562:13)
    at JobCatalogService.preflightJob (src/core/job-catalog-service.js:415:22)
    at PlatformService.preflightJob (src/core/platform-service.js:1265:30)
    at handleJobRoute (src/protocols/http/job-routes.js:105:39)
  code: 'job_not_found', statusCode: 404
Node.js v22.23.2
```

Five times for `pr-pmxt-dev-pmxt-2418`, then once each for
`pr-lumio-network-lumio-app-51`, `pr-quanta-js-quanta-131` and
`pr-dupdab-dupdap-frontend-366`: an outside agent preflighted GitHub-PR jobs that had
left the catalogue. Nothing malicious; each restart dropped more listings, which made
more cached ids unknown.

## Cause

`PlatformService.preflightJob` (since #1174, 2026-08-19):

```js
const [preflight, job] = await Promise.all([
  this.jobCatalogService.preflightJob(wallet, jobId),              // promise created, rejects
  this.attachClaimState(this.getJobDefinition(jobId), { wallet })  // throws synchronously
]);
```

For an unknown job the second element throws while the array is still being built,
so `Promise.all` never receives the first element's rejected promise. The request got
its 404 through the server's catch; the orphaned rejection then ended the process under
Node 22's default `--unhandled-rejections=throw`. No `unhandledRejection` handler
existed. Any signed-in wallet could trigger it with one request.

## How it was found

Hermes showed CAPABILITIES RED on 2026-09-25 (a separate issue, see
`PACKET_BACKEND_READ_PRESSURE.md`). Pascal's `docker inspect` showed `restarts=8`; the
crash dumps came from `docker logs -t` over the restart window. Lesson for log
forensics: the lines just before `http.listening` belong to the NEW process's boot —
anchor on the non-JSON crash dump instead.

## Fix — #1401 (`a66c23de`), gated by Claude

- `preflightJob` resolves the job definition before any promise is created.
- 129 `Promise.all`-style sites audited; 15 fixed (synchronous prerequisites hoisted or
  elements wrapped as `Promise.resolve().then(...)`), each with a named regression.
- HTTP-process `unhandledRejection` monitor: one error-level
  `process.unhandled_rejection` log line, `process_unhandled_rejections_total`, and a
  critical `/health` warning `process_unhandled_rejection` for 24 h. It does not exit;
  `uncaughtException` keeps Node's fatal default.
- Gate evidence (Claude, Node 22.22.0): 17 unit + 2 HTTP smoke tests pass
  (`RUN_HTTP_SMOKE=1`); restoring the old ordering turns
  `http smoke: unavailable preflight is a handled 404 after the event loop drains` red
  with the same `job_not_found` rejection.
- Follow-up #1402: the public `/health` warning carries no raw error text (count and
  lastAt only; message and stack stay in the log line).

## Still open

- Post-deploy: `RestartCount` of `agent-mainnet-backend` stays 0 (operator check).
- The catalogue lives in RAM, so every restart or deploy drops ingested listings until
  the schedulers re-ingest them (packet `faa042de`, unshipped). After the 2026-09-25
  deploy `/jobs` listed 3 jobs and `/health` raised `onboarding_waiver_inventory_empty`.
