# Ready-to-Post Jobs

This file turns the first-wave catalog into concrete job definitions that fit
the current admin job API and operator console.

Use these jobs first because they are:

- directly useful to the Averray team
- low-ambiguity enough for the current verifier stack
- easy to explain to outside operators
- structured enough to create durable outputs

The matching machine-readable bundle lives at
[docs/ready-to-post-jobs.json](/Users/pascalkuriger/repo/Polkadot/docs/ready-to-post-jobs.json).
To post the bundle in one shot, use
[scripts/post_job_bundle.mjs](/Users/pascalkuriger/repo/Polkadot/scripts/post_job_bundle.mjs).

---

## Fastest posting path

Dry run first:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT='<admin-jwt>' \
node scripts/post_job_bundle.mjs --dry-run
```

Post all four jobs:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT='<admin-jwt>' \
node scripts/post_job_bundle.mjs
```

Post only one or two jobs:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT='<admin-jwt>' \
node scripts/post_job_bundle.mjs --only pr-review-findings-001,release-readiness-check-001
```

What the helper does:

- reads [docs/ready-to-post-jobs.json](/Users/pascalkuriger/repo/Polkadot/docs/ready-to-post-jobs.json)
- fetches the current job list from `/jobs`
- skips any job ids that already exist
- posts only the missing jobs to `/admin/jobs`

---

## Posting defaults

Use these definitions as written unless you have a specific reason to change
them:

- reward asset: `DOT`
- sponsored gas: `true`
- retry limit: `1`
- one-shot jobs first; add recurring templates later
- submit structured JSON-like output so verifier keywords line up with field
  names

---

## 1. PR Review Findings

Best for: structured code-review output with severity, file references, and a
clear next step.

Why this is worth posting:

- creates reusable engineering output
- easy to judge for usefulness
- aligns with the existing product story around operator work

Suggested worker output shape:

```json
{
  "summary": "Short review summary",
  "findings": [
    {
      "severity": "high|medium|low",
      "file": "path/to/file",
      "issue": "What is wrong",
      "recommendation": "What to change"
    }
  ],
  "risk_level": "low|medium|high",
  "files_touched": ["path/to/file"],
  "recommended_next_step": "merge|fix_and_retest|request_changes"
}
```

Ready-to-post payload:

```json
{
  "id": "pr-review-findings-001",
  "category": "review",
  "tier": "starter",
  "rewardAsset": "DOT",
  "rewardAmount": 6,
  "verifierMode": "benchmark",
  "verifierTerms": [
    "summary",
    "findings",
    "risk_level",
    "files_touched",
    "recommended_next_step"
  ],
  "verifierMinimumMatches": 4,
  "inputSchemaRef": "schema://jobs/review-input",
  "outputSchemaRef": "schema://jobs/pr-review-findings-output",
  "claimTtlSeconds": 5400,
  "retryLimit": 1,
  "requiresSponsoredGas": true
}
```

Operator note:
- reject submissions that contain no file references or no severity labels

---

## 2. Release Readiness Check

Best for: a go/no-go release gate against a fixed checklist.

Why this is worth posting:

- creates an operator-ready artifact instead of loose commentary
- strongly structured and easy to verify
- naturally repeatable before every release

Suggested worker output shape:

```json
{
  "release_id": "release-2026-04-18",
  "checks_passed": ["item"],
  "checks_failed": ["item"],
  "blockers": ["item"],
  "go_no_go": "go|no_go"
}
```

Ready-to-post payload:

```json
{
  "id": "release-readiness-check-001",
  "category": "release",
  "tier": "starter",
  "rewardAsset": "DOT",
  "rewardAmount": 7,
  "verifierMode": "deterministic",
  "verifierTerms": [
    "release_id",
    "checks_passed",
    "checks_failed",
    "blockers",
    "go_no_go"
  ],
  "verifierMatchMode": "contains_all",
  "inputSchemaRef": "schema://jobs/release-input",
  "outputSchemaRef": "schema://jobs/release-readiness-output",
  "claimTtlSeconds": 3600,
  "retryLimit": 1,
  "requiresSponsoredGas": true
}
```

Operator note:
- require every checklist section, even when one of the arrays is empty

---

## 3. Issue / Defect Triage

Best for: turning loose issue reports into a routing-friendly structured
record.

Why this is worth posting:

- removes repetitive operational grunt work
- easy to batch
- ideal for strict enumerated outputs

Suggested worker output shape:

```json
{
  "category": "bug|ops|docs|governance|integration",
  "severity": "low|medium|high|critical",
  "component": "api|indexer|frontend|contracts|ops",
  "repro_clarity": "clear|partial|unclear",
  "next_owner": "backend|frontend|ops|contracts|docs",
  "duplication_risk": "low|medium|high"
}
```

Ready-to-post payload:

```json
{
  "id": "issue-defect-triage-001",
  "category": "triage",
  "tier": "starter",
  "rewardAsset": "DOT",
  "rewardAmount": 5,
  "verifierMode": "deterministic",
  "verifierTerms": [
    "category",
    "severity",
    "component",
    "repro_clarity",
    "next_owner",
    "duplication_risk"
  ],
  "verifierMatchMode": "contains_all",
  "inputSchemaRef": "schema://jobs/triage-input",
  "outputSchemaRef": "schema://jobs/issue-defect-triage-output",
  "claimTtlSeconds": 2700,
  "retryLimit": 1,
  "requiresSponsoredGas": true
}
```

Operator note:
- reject free-form categories that ignore the requested enums

---

## 4. Docs Drift Audit

Best for: checking whether public docs, manifests, and operator surfaces still
agree with the live system.

Why this is worth posting:

- directly protects trust and discovery surfaces
- catches one of your real launch risks: docs drift
- useful even before a broader external marketplace exists

Suggested worker output shape:

```json
{
  "source_surface": "what was reviewed",
  "drift_findings": [
    {
      "surface_a": "first source",
      "surface_b": "second source",
      "mismatch": "what drifted"
    }
  ],
  "missing_updates": ["item"],
  "severity": "low|medium|high",
  "fix_recommendation": "what to update next"
}
```

Ready-to-post payload:

```json
{
  "id": "docs-drift-audit-001",
  "category": "docs",
  "tier": "starter",
  "rewardAsset": "DOT",
  "rewardAmount": 5,
  "verifierMode": "benchmark",
  "verifierTerms": [
    "source_surface",
    "drift_findings",
    "missing_updates",
    "severity",
    "fix_recommendation"
  ],
  "verifierMinimumMatches": 4,
  "inputSchemaRef": "schema://jobs/docs-input",
  "outputSchemaRef": "schema://jobs/docs-drift-audit-output",
  "claimTtlSeconds": 3600,
  "retryLimit": 1,
  "requiresSponsoredGas": true
}
```

Operator note:
- allow `drift_findings: []` only when the submission still explains what was
  checked and why no drift was found

---

## Launch order

Post in this order:

1. `pr-review-findings-001`
2. `release-readiness-check-001`
3. `issue-defect-triage-001`
4. `docs-drift-audit-001`

Why this order:

- strongest verifier fit first
- highest internal utility first
- lowest ambiguity first

---

## Before posting

Quick operator checklist:

- confirm the job id is still unused
- keep the tier at `starter` for first live runs
- keep rewards conservative until you have real completion data
- post one job at a time and observe claim / submit / verify behavior
- adjust verifier terms only after reviewing real failed submissions
