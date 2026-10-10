# Legacy GitHub repository identity backfill

Finding: the 2026-10-10 repository-identity gate found that pre-#1485 jobs have
no ingestion-time repository ID. Name plus creation date cannot distinguish an
old repository later renamed into that name. #1486 protects missing/failed
lookups; this backfill pins the operator-reviewed current identity going forward.
It cannot reconstruct historical ownership. Review candidates before applying.

## Operator procedure (not run automatically)

Use the existing admin authentication and `admin_jobs` rate-limit boundary:
`POST /admin/jobs/github-repository-ids/backfill`. Supply explicit IDs from the
admin jobs list, at most 10 unique candidates per batch. The input array itself
is capped at 10; duplicates are processed once. No catalogue-wide scan runs.

```json
{"jobIds":["legacy-pr"]}
```

Dry-run is the default. Example from the committed synthetic fixture (not a
production backfill):

```json
{"dryRun":true,"pinned":0,"wouldPin":1,"skipped":0,"rows":[{"jobId":"legacy-pr","status":"would_pin","githubRepoId":42}]}
```

Review skipped rows and their reason before retrying. To apply, repeat the same
IDs with `"apply":true`; the server re-reads eligibility and GitHub rather than
trusting the dry-run output. A dry-run does not create an idempotency receipt or
any pin. Each GitHub read (including its response body) has a 5-second abort
deadline; reads are sequential, at most 10 per request. Redirects are refused.
Lookup failures leave the job unpinned and report a reason, never response bodies.
No new environment values are needed: the existing `GITHUB_TOKEN` is used.

Only open `github_issue`-sourced, `github_pr`-verified jobs without an existing
ID are eligible. A latest resolved session also excludes the job. The current
GitHub response must have a positive safe-integer ID, an exact `full_name` match
to the stored `owner/repo`, and a valid `created_at` strictly before the job's
`lifecycle.createdAt`. Renames/transfers, missing dates, same/newer dates, and
lookup failures require operator review, not an automatic pin.

## Storage and consumers

Pins are immutable verification metadata, not catalogue mutations. Memory uses
put-if-absent; Redis uses atomic `SET NX` at
`<namespace>:github-repository-pin:<identity hash>`, without an expiry. Repeated
or concurrent applies never overwrite a pin. The identity hash binds job ID,
the entire original source, and job creation time; reused IDs or changed sources
cannot inherit an old pin. The record stores `source.githubRepoId`, GitHub's
name/creation date, the job creation date, pin time, and `origin: operator_backfill`.

After snapshot-integrity validation, `VerifierService` supplies a cloned source
with `githubRepoId` to the existing verifier for preview, settlement evaluation,
and replay. Catalogue/worker definitions, claim snapshots, definition hashes,
spec hashes, and receipt audit preimages are unchanged. Existing ingestion-time
IDs win. The current verifier reports these trusted cached IDs as `ingested`;
the separate pin record retains the exact backfill provenance. Corrupt pins or
store errors fail closed rather than silently falling back to name resolution.

Consumers checked: GitHub ingestion (unchanged), the three `VerifierService`
evaluation paths, admin HTTP route/auth/limiter, Memory and Redis persistence,
worker/catalogue reads and snapshot hashing (unchanged). The public OpenAPI/SDK
is intentionally unchanged: this is an admin-only operation, not a public tool.
No frontend, indexer, contracts, deployment, or environment changes.
