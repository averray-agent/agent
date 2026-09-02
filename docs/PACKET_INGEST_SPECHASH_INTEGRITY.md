# PACKET — Re-ingestion must never break a chain commitment

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal
**Date:** 2026-08-12 · Status: ready after the two `0xae79Ad22…` sessions settle and `bb3fb04` deploys.

This file is handed over directly (not in any git ref). Verify every line reference against `origin/main` — worktrees have produced wrong answers repeatedly.

---

## 1. The incident this generalizes

2026-08-12, ~23:39–06:45: wallet `0xae79Ad22EB2723f40678Cb8A1e098bC9A27E8aA0` — likely our first external worker — claimed and submitted two jobs. Both sessions failed `assertJobSnapshotIntegrity` every 60s for 7+ hours with `job_snapshot_on_chain_spec_hash_mismatch`, degrading `/health` to 503 and blocking every production deploy, including the deploy of the fix.

Codex's forensic established (and I verified the reasoning, not the reads):

- Both pinned snapshots intact; every stored hash recomputes exactly. **Pinning worked.**
- Both submissions verified against external reality. **The worker did nothing wrong.**
- All re-ingestions predated the claims. The re-ingest **lifecycle timestamp is inside the hashed canonical definition**, so ingestion re-materializing a definition under an existing jobId changed its `specHash` away from the one committed on chain at creation (`gateway.js:1254` `hashCanonicalContent(job)`).

**The general fact: every re-ingest drifts every committed job.** Any job that sits on the board across one ingest cycle becomes a trap — and it selectively catches outsiders, because our canary and worker loop claim fresh jobs while external browsers pick older ones.

The verify-time gate (#1070) is correct and stays. Its flaw is *timing*: it fires after the work is done, at the worst possible moment for the worker.

## 2. The invariant

> **A definition served for a chain-committed job must reproduce that job's committed `specHash` at every moment it is claimable.** Ingestion may refresh content only if the refreshed canonical form still hashes to the commitment; otherwise the refresh is refused. A claim on a job that cannot prove its terms is refused *before* the session exists.

## 3. Fixes — one PR each, in this order

### F1 — Claim-time assertion (stops the harm immediately)

In the claim path (`mcp-server/src/core/job-execution-service.js`, where `buildJobSnapshot` is called): after pinning, call the **existing** `assertJobSnapshotIntegrity` (`job-snapshot.js:140`) against the chain **before creating the session**. On mismatch: refuse the claim with a distinct, honest error (`job_definition_chain_mismatch` or similar — a claim-scope code, not the session-scope one), do not create the session, do not charge anything.

- **Preflight parity is mandatory** (the #834 lesson): `preflightJob` / `explainEligibility` must run the same check and report the same refusal, so an agent learns *before* attempting work, not at claim.
- Distinguish `job_snapshot_chain_read_unavailable` (`job-snapshot.js:148`) from mismatch: a transient RPC failure must not refuse claims — fail open on read-unavailable at claim time (the verify-time gate still protects settlement), fail closed on genuine mismatch.

### F2 — Ingest-time invariant (stops the drift at its source)

At the shared catalogue upsert the five ingestion schedulers use (Codex: locate the exact write site — I have not read it and will not guess): when the target jobId has an on-chain commitment, recompute the canonical hash of the refreshed materialization.

- Reproduces the committed `specHash` → write (idempotent refresh).
- Does not → **refuse the overwrite**, keep the currently served definition, and count it (`ingest_refused_spec_hash_mismatch` in the scheduler's summary — visible, not silent).
- If the *currently served* definition already fails to reproduce the commitment (legacy drift, today's state): mark the job **unclaimable** and surface it distinctly on the board data (see F3). Never serve a claimable job whose claim F1 would refuse — that is a truth-boundary violation (jobs displayed as available that cannot be taken).

Design note, considered and rejected for now: excluding volatile lifecycle fields from the canonical preimage would eliminate the class, but changing the hash scheme near money requires versioned normalization and ceremony-grade care. Not in this packet; record it as a candidate for the EscrowCore v3 window, where a scheme version bump is natural.

### F3 — Sweep + reconcile the existing board

One-off script plus a recurring check inside the ingest cycle: enumerate every served job with a chain commitment, recompute, report `{ total, matching, drifted }`. Drifted ones become unclaimable per F2.

- **The first run's `drifted` count is the headline number** — given the forensic, it may be most of the board. Report it to Pascal before flipping anything; if it exceeds half the board, pause and hand back (that is a product decision, not a mechanical one).
- Unclaimable jobs hold escrowed rewards on chain. The recovery path already exists: the operator tombstone rescue (~7d window, PR #877 design). Reference it in the unclaimable marking; do not build new reclaim machinery.

### F4 — Small: stop counting per-session holds as scheduler failures

`summaryErrorsOutcome(..., "auto_verification_errors")` treats a run containing per-session integrity holds as a failed run, so `consecutiveSchedulerFailures` reached 426 while the scheduler was perfectly healthy. A deterministic per-session hold is not a scheduler fault: route integrity holds to the skip/hold bucket (they already stream into the session streak via #1077's rule), and let `consecutiveSchedulerFailures` mean what its name says. One function, one test.

## 4. Acceptance (what Claude verifies on handback)

- **F1:** a job whose served definition mismatches its commitment → `claimJob` refuses with the new code, creates no session, and `preflightJob` predicts the refusal. A chain-read outage at claim → claim proceeds (fail open), and a test proves the verify-time gate still holds the settlement.
- **F2:** re-ingest that reproduces the hash → write occurs; re-ingest that does not → served definition unchanged, refusal counted in the scheduler summary. Legacy-drifted job → marked unclaimable, absent from claimable listings, present in an operator-visible drifted list.
- **F3:** sweep output shows `{total, matching, drifted}`; the >50% handback guard is real code, not convention.
- **F4:** a run whose only anomalies are per-session integrity holds ends with `consecutiveSchedulerFailures === 0`; a run where `runOnce` throws still increments it.
- **Everywhere:** no change to `contracts/`, `deployments/`, verify-time semantics, or the A1–A4 health contract.

## 5. Not in scope

- Recovering or re-keying the two `0xae79Ad22…` sessions (settled separately, by Pascal's decision).
- Hash-scheme changes (v3 window candidate, §3-F2 note).
- The daily-rate-limit ladder rung, deposit pool, EscrowCore v3 — tracked elsewhere.

## 6. Open question for Pascal

One only: if the F3 sweep reports most of the board drifted, do you want the board visibly thin (honest, fewer claimable jobs) while ingestion re-posts fresh commitments, or a quiet grace period where drifted jobs stay claimable behind F1's refusal? My recommendation is the thin honest board — a job that refuses every claim is worse than an empty slot — but it is visible to outsiders and therefore yours to call.
