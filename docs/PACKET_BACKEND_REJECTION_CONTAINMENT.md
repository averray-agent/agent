# PACKET — backend rejection containment (handed to Codex directly on 2026-09-25; recorded after #1401 deployed)

DIRECTIVE: implement this in averray-agent/agent from a fresh worktree off origin/main, one PR. Do not just review or summarize. Production hotfix. The repo is public: the PR title and body state what changed, but do not describe how to trigger the crash until it is deployed.

WHAT HAPPENED. On 2026-09-24 the mainnet backend process died 8 times between 12:10 and 16:04 UTC (Docker RestartCount 8). Every exit printed the same unhandled rejection:

  NotFoundError: Unknown job: pr-pmxt-dev-pmxt-2418
      at JobCatalogService.requireJob (src/core/job-catalog-service.js:562:13)
      at JobCatalogService.preflightJob (src/core/job-catalog-service.js:415:22)
      at PlatformService.preflightJob (src/core/platform-service.js:1265:30)
      at handleJobRoute (src/protocols/http/job-routes.js:105:39)
      at async Server.<anonymous> (src/protocols/http/server.js:1123:9) {
    code: 'job_not_found', statusCode: 404, details: undefined }
  Node.js v22.23.2

The same crash also happened for pr-lumio-network-lumio-app-51, pr-quanta-js-quanta-131 and pr-dupdab-dupdap-frontend-366: an outside agent preflighted PR jobs that had left the catalogue.

MECHANISM (reproduced on Node 22). PlatformService.preflightJob, since #1174 (2026-08-19):

  const [preflight, job] = await Promise.all([
    this.jobCatalogService.preflightJob(wallet, jobId),              // async: promise created, then rejects
    this.attachClaimState(this.getJobDefinition(jobId), { wallet })  // throws synchronously while the array is built
  ]);

For an unknown job the second element throws before Promise.all runs, so the first element's rejected promise never gets a handler. The request still gets its 404 through the server's catch. The orphaned rejection then terminates the process: Node 22 defaults to --unhandled-rejections=throw, and mcp-server/src has no unhandledRejection handler.

D1 — fix the call. In PlatformService.preflightJob, run every synchronous lookup that can throw (getJobDefinition(jobId)) before any promise is created. Known jobs get an identical response.

D2 — sweep the pattern. Find every array literal passed to Promise.all / allSettled / race / any in mcp-server/src where an element that creates a promise comes before an element that can throw synchronously: a sync lookup, a require*/get* validator, JSON.parse, or property access on a possibly-undefined value. Fix every site reachable from an HTTP route, an MCP tool or a scheduler, either by hoisting the sync work or by wrapping the element as Promise.resolve().then(() => ...). List every site in the handback, fixed or not, with one line of reasoning each.

D3 — process guard. In the HTTP server entrypoint, add process.on("unhandledRejection", ...) that does three things:
- logs process.unhandled_rejection at error level with the serialized error (name, message, code, stack);
- increments a metric;
- adds a critical /health warning process_unhandled_rejection (count, lastAt, lastMessage) for 24 h after the last occurrence.
It does NOT exit. In a request server an orphaned rejection is almost always the sibling of a failure the request already reported, and exiting drops every in-flight request, the Substrate watches and the in-memory catalogue. Leave uncaughtException at Node's default, which exits. Put this reasoning in the PR body.

TESTS. Run them under Node 22, CI's version; Node 25 does not reproduce Node-22 test-runner behaviour.
1. HTTP: GET /jobs/preflight?jobId=<unknown> with a valid wallet token returns 404 job_not_found, and no unhandledRejection fires. The test registers a listener and fails if it fires after microtasks and one macrotask have drained. Drill: revert D1 and show this test going red; paste the red output in the handback.
2. D3: an orphaned rejection produces one error-level process.unhandled_rejection log line and the critical /health warning, and the next request is still served 200.
3. A regression test for each reachable D2 site, or a note saying why not.

CHECKS. npm --workspace mcp-server test, plus whatever CI requires for backend changes. No env or VPS changes.

HANDBACK. PR number, CI result, the D1 drill (red, then green), the D2 site list and the merge SHA. After deploy, Claude verifies that an unknown-job preflight answers 404 and that the backend's RestartCount stays 0.
