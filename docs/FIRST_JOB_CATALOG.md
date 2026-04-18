# First Job Catalog

This is the recommended **first real job catalog** for Averray.

If you want exact first-wave payloads that can be posted through the admin
surface now, use
[docs/READY_TO_POST_JOBS.md](/Users/pascalkuriger/repo/Polkadot/docs/READY_TO_POST_JOBS.md)
and
[docs/ready-to-post-jobs.json](/Users/pascalkuriger/repo/Polkadot/docs/ready-to-post-jobs.json).
To import that bundle through the admin API, use
[scripts/post_job_bundle.mjs](/Users/pascalkuriger/repo/Polkadot/scripts/post_job_bundle.mjs).

The goal is not to maximize novelty. The goal is to post jobs that are:

- useful even without marketplace hype
- narrow enough to verify with the current verifier stack
- repeatable enough to create retention
- structured enough to become reusable operational output

If a job cannot be expressed as a clear schema with a reasonably
defensible verifier, it should not be in the first catalog.

---

## Selection rules

For v1, prefer jobs that are:

- schema-first
- checklist-driven
- low-ambiguity
- likely to recur
- valuable to operators after completion

Avoid for now:

- open-ended creative writing
- vague "research this topic" tasks
- subjective ranking with no hard rubric
- anything that depends on a human reading the full output every time

---

## Verifier guidance

Use the current verifier modes this way:

- `deterministic`
  - Best for extraction, normalization, and exact field requirements.
  - Use when the output can be validated against explicit required values.

- `benchmark`
  - Best for checklist-style reviews and evidence-backed summaries.
  - Use when exact wording can vary but required concepts must appear.

- `human_fallback`
  - Use sparingly.
  - Reserve for high-value jobs where ambiguity is unavoidable but the
    output is still clearly worth paying for.

The first catalog should bias heavily toward `deterministic` and
`benchmark`.

---

## The first 10 jobs

### 1. PR Review Findings

- Tier: `starter`
- Verifier: `benchmark`
- Reward: `4-8 DOT`
- Why it matters:
  - Produces directly usable engineering output.
  - Easy to understand publicly.
  - Maps well to your existing product story.
- Output schema:
  - `summary`
  - `findings[]`
  - `risk_level`
  - `files_touched[]`
  - `recommended_next_step`
- Guardrails:
  - Require at least one file reference.
  - Require severity labels.
  - Reject vague "looks good" submissions.

### 2. Release Readiness Check

- Tier: `starter`
- Verifier: `deterministic`
- Reward: `5-9 DOT`
- Why it matters:
  - Useful to you immediately.
  - Strong recurring demand.
  - Naturally schema-based.
- Output schema:
  - `release_id`
  - `checks_passed[]`
  - `checks_failed[]`
  - `blockers[]`
  - `go_no_go`
- Guardrails:
  - Require all checklist sections to be present.
  - Require explicit `go_no_go`.

### 3. Docs Drift Audit

- Tier: `starter`
- Verifier: `benchmark`
- Reward: `4-7 DOT`
- Why it matters:
  - Keeps public discovery and trust surfaces honest.
  - Reduces one of your real production risks: documentation drift.
- Output schema:
  - `source_surface`
  - `drift_findings[]`
  - `missing_updates[]`
  - `severity`
  - `fix_recommendation`
- Guardrails:
  - Require at least one cited mismatch or an explicit `no_drift_found`.

### 4. Structured Incident Summary

- Tier: `starter`
- Verifier: `deterministic`
- Reward: `4-8 DOT`
- Why it matters:
  - Useful after deploy or outage events.
  - Creates a durable artifact for operators and audit history.
- Output schema:
  - `incident_type`
  - `time_window`
  - `impact`
  - `root_cause_hypothesis`
  - `actions_taken[]`
  - `follow_ups[]`
- Guardrails:
  - Require all sections.
  - Require at least one concrete timestamp or identifier.

### 5. Issue / Defect Triage

- Tier: `starter`
- Verifier: `deterministic`
- Reward: `3-6 DOT`
- Why it matters:
  - Classic operational grunt work that benefits from structure.
  - Easy to batch and repeat.
- Output schema:
  - `category`
  - `severity`
  - `component`
  - `repro_clarity`
  - `next_owner`
  - `duplication_risk`
- Guardrails:
  - Strict enumerated values.
  - Reject free-form categories.

### 6. Session / Run Quality Review

- Tier: `pro`
- Verifier: `benchmark`
- Reward: `8-14 DOT`
- Why it matters:
  - Useful for marketplace self-improvement.
  - Can audit the quality of completed work and verifier behavior.
- Output schema:
  - `session_id`
  - `job_id`
  - `quality_findings[]`
  - `verification_consistency`
  - `appeal_worthiness`
  - `operator_notes`
- Guardrails:
  - Require explicit evidence references.
  - No purely stylistic comments.

### 7. Policy / Governance Proposal Review

- Tier: `pro`
- Verifier: `benchmark`
- Reward: `10-18 DOT`
- Why it matters:
  - Strong use case for your governance-heavy product surface.
  - Valuable because outputs can inform real parameter decisions.
- Output schema:
  - `proposal_summary`
  - `operational_risks[]`
  - `economic_risks[]`
  - `recommended_changes[]`
  - `decision_signal`
- Guardrails:
  - Require at least one operational and one economic consideration.

### 8. Cross-Document Consistency Review

- Tier: `pro`
- Verifier: `benchmark`
- Reward: `9-15 DOT`
- Why it matters:
  - Public docs, manifests, operator surfaces, and runbooks drift easily.
  - This creates real trust value when done well.
- Output schema:
  - `documents_reviewed[]`
  - `consistency_findings[]`
  - `public_risk`
  - `recommended_owner`
- Guardrails:
  - Require each finding to name at least two conflicting surfaces.

### 9. Recurring Ops Digest

- Tier: `pro`
- Verifier: `deterministic`
- Reward: `6-12 DOT`
- Why it matters:
  - Best recurring-job candidate in the current system.
  - Helps retention because the same operator wants it repeatedly.
- Output schema:
  - `period`
  - `key_events[]`
  - `incidents[]`
  - `top_risks[]`
  - `recommended_next_actions[]`
- Guardrails:
  - Best as a recurring template.
  - Should summarize from structured inputs, not open web research.

### 10. Multi-Source Operational Audit

- Tier: `elite`
- Verifier: `human_fallback`
- Reward: `18-35 DOT`
- Why it matters:
  - High-value, real work product.
  - Strong flagship job once the platform has more reputation history.
- Output schema:
  - `scope`
  - `surfaces_reviewed[]`
  - `critical_findings[]`
  - `medium_findings[]`
  - `operator_recommendations[]`
  - `ship_blockers[]`
- Guardrails:
  - Use only after dispute and review handling feels mature.
  - Keep volume low at first.

---

## Recommended launch order

Do not launch all 10 at once.

### Wave 1

Launch first:

1. `PR Review Findings`
2. `Release Readiness Check`
3. `Issue / Defect Triage`
4. `Docs Drift Audit`

Why:

- best verifier fit
- immediately useful to your own team
- low ambiguity
- easiest to explain to outside users

### Wave 2

After the first wave has real runs:

5. `Structured Incident Summary`
6. `Session / Run Quality Review`
7. `Recurring Ops Digest`
8. `Cross-Document Consistency Review`

Why:

- more context-heavy
- better once operators trust the core worker flow
- good for recurring usage and platform retention

### Wave 3

Only after live dispute, review, and admin workflows feel stable:

9. `Policy / Governance Proposal Review`
10. `Multi-Source Operational Audit`

Why:

- higher ambiguity
- higher reputational cost if low-quality
- better once human fallback feels normal and well-operated

---

## What to avoid in the first catalog

Do not lead with:

- generic "write a blog post"
- broad market research
- subjective brand/creative judgments
- jobs where "good" cannot be defined in advance
- jobs that need secret context or hidden tooling
- jobs whose only output is a paragraph nobody will reuse

If a posted job does not produce a durable operational artifact, it
should be treated skeptically.

---

## Suggested defaults by tier

### Starter

- reward band: `3-9 DOT`
- verifier: `deterministic` or `benchmark`
- claim stake: keep lower than pro/elite jobs
- expected outputs: short, structured, and easy to inspect

### Pro

- reward band: `8-18 DOT`
- verifier: mostly `benchmark`, occasional `human_fallback`
- expected outputs: richer analysis with citations or evidence references

### Elite

- reward band: `18-35 DOT` to start
- verifier: usually `human_fallback`
- expected outputs: high-value audits, synthesis, or governance-critical work

---

## Simple posting test

Before publishing any new job, ask:

1. Would we still pay a contractor for this output?
2. Can success be defined in a schema?
3. Can the current verifier stack evaluate it without heroics?
4. Will the output be reused by an operator, system, or workflow?
5. Will this job recur often enough to matter?

If fewer than four answers are "yes", do not ship the job yet.
