# Averray worker → money-rail seam: integration handoff

Track A (the demand-side **work engine**) is complete and merged (#783, #785, #786,
#788, #789), proven end to end with a real model on both the local and
`--network none` Docker providers. This note hands it to the money-rail-seam
owner — the hosted worker loop (`scripts/ops/run-hosted-worker-loop.mjs`) and the
chain claim/settle code (`mcp-server/src/core/job-execution-service.js`), Codex's
lane. **The worker never touches the money rail**; it does the work and proves it,
producing a *verified submission object* the seam submits.

## The earn loop, and where the worker sits

```
 discover        ┌──────── money-rail seam (Codex) ────────┐   ┌── WORKER (this dir) ──┐   ┌──── money-rail seam (Codex) ────┐
 GET /jobs/      │ SIWE auth  →  claim (stake)              │ → │ prepare workspace     │ → │ open GitHub PR → prUrl          │
 definition      │ /auth/nonce,/verify   POST /jobs/claim   │   │ emit intent → run     │   │ validate → submit → settle      │
 (public)        │ (backend-brokered claimJobFor)           │   │ → verified deliverable│   │ POST /jobs/submit, /verifier/…  │
                 └─────────────────────────────────────────┘   └───────────────────────┘   └─────────────────────────────────┘
```

The worker occupies only the middle box. Everything with a wallet, key, stake, or
on-chain call is the seam owner's.

## Worker I/O contract (the integration points)

**Input** — an Averray job definition, fetched read-only (no wallet):
`GET /jobs/definition?jobId=…` via `worker/src/averray-client.js` `fetchJobDefinition`.

**Invoke** — three worker calls (all pure/CLI, no money rail):

1. `mapJobToTaskIntent(job, { workspacePath, verifyCommand?, forbiddenPaths?, … })`
   → `{ intent, warnings }`. The seam must first **clone `job.source.repo`** to a
   local path (`workspacePath`) — a networked read done host-side, *before* the
   run; the sandbox has no network. If `warnings` is non-empty the job is not
   deterministically gated — **do not submit it** (see guarantees).
   (CLI equivalent: `node worker/bin/emit-intent.mjs <job.json> --workspace <path>`;
   exit 3 == unverifiable.)
2. `new HarnessDriver({ databaseUrl, env }).runToCompletion(intentPath, …)`
   → `{ runId, status, deliverables }`. `deliverables` maps
   `{ workspace_patch, verification_report, change_summary } → artifact://…`;
   fetch bytes with `driver.artifactGet(uri)`. Terminal == the status has an
   `outcome` (`completed`/`partial`/`failed`); `completed` means every required
   acceptance check passed.
3. `assembleGithubPrSubmission({ job, prUrl, verificationReport, changeSummary, patchText, ciStatus? })`
   → the `schema://jobs/github-pr-evidence-output` object (`prUrl`, `summary`,
   `tests`, `filesChanged`, `issueNumber`, …). **`prUrl` comes from the seam's
   PR-open step.** It **throws** if `verificationReport.passed !== true`.

**Output** — that submission object, ready for `POST /jobs/validate-submission`
(public, no auth) then `POST /jobs/submit`.

All four functions are exported from `worker/src/index.js`.

## What the seam owner supplies / does (NOT in the worker)

- **Wallet + SIWE auth**: `/auth/nonce` → sign → `/auth/verify` → Bearer JWT. Note
  a self-registered wallet gets `roles: []`, which claim/submit accept, but its
  refresh chain is rejected (`no_roles_at_refresh`) — re-run nonce/verify on
  expiry. (Codex's `run-hosted-worker-loop.mjs` refresh flow handles this.)
- **Claim**: `POST /jobs/claim {jobId}` — backend brokers `claimJobFor` and pays
  gas; a non-waived GitHub job locks stake (~0.06 USDC at code defaults). Money rail.
- **Repo checkout**: clone `job.source.repo` → the `workspacePath` above.
- **Sandbox image**: `docker build -t averray-worker-sandbox:latest worker/sandbox`
  (loaded locally; providers never pull) + `HARNESS_ENV_IMAGE`. Model key via
  `HARNESS_MODEL_*` (never in the worker).
- **PR-open**: open a GitHub PR from the `workspace_patch` (external write,
  approval-gated) → `prUrl`. The platform auto-appends its disclosure footer on
  submit; the exact requirements are in the job's `submissionContract` block.
- **Submit + settle**: `POST /jobs/submit {sessionId, submission}`; poll
  `GET /verifier/result?sessionId=…` for `outcome:"approved"` + `payoutTx`
  (github_pr is operator-verified, not auto). Money rail.

## Guarantees the worker gives the seam

- **No money rail in the worker**: no wallet, key, signer, claim, or submit — the
  profile grants only `fs.*`/`shell.run`/`git.*`/`artifact.*` (grep-clean).
- **Isolation for real jobs**: the profile pins `provider: docker` + `deny_all`
  egress; the harness runs `--network none` and rejects a run whose container
  `NetworkMode` ≠ `none`. (`local` provider is trusted/dev only.)
- **Never lies**: `assembleGithubPrSubmission` refuses any deliverable whose
  verification did not pass; unverifiable jobs are flagged (warning + exit 3),
  never converted to an LLM rubric.
- **Both patch formats**: local emits git-format `workspace_patch`, docker emits
  difflib format; the assembler's `filesChangedFromPatch` handles both.

## Source of truth & prior art

- The job's `submissionContract` / `verificationContract` blocks (returned by
  `GET /jobs/definition`) are **authoritative** for the submit/verify shapes —
  read them at runtime rather than hard-coding.
- The Hermes `averray-reference-agent/` already implements SIWE auth + a wallet
  MCP + `averray_claim`/`averray_submit`/draft-submission on testnet — a working
  reference for the seam (a different, Hermes-based runtime).

## Pointers

- Worker: [`worker/`](.) — [README](README.md), profile, `src/`, `sandbox/Dockerfile`.
- Build spec: [`docs/packets/PKT-AVGW-001-averray-worker.md`](../docs/packets/PKT-AVGW-001-averray-worker.md) (errata inline).
- Live proof (operator-run): `npm run smoke:live` (local), `npm run smoke:stage2`
  (docker); `npm run gate:docker` needs no model key.
- Seam in progress (Codex): `scripts/ops/run-hosted-worker-loop.mjs` (auth+claim),
  `mcp-server/src/core/job-execution-service.js` (`claimJobFor`, submit/verify).
