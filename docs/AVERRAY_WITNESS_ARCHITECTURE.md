# Averray Witness — architecture

Status: **agreed, unbuilt.** Written 2026-08-16. Supersedes the assumption that the
Agent-Harness worker would compete for bounties.

## 1. What it is

The Averray Witness is an isolated **execution verifier**. It receives an immutable
repository, an immutable candidate artifact, and a frozen Verification Contract;
evaluates them inside a network-denied sandbox; and emits a content-addressed
**Verification Receipt** recording exactly what ran, in which environment, with what
result.

It returns `PASS`, `FAIL`, `INCONCLUSIVE` or `POLICY_VIOLATION`. It cannot issue
`PASS` without the evidence the frozen contract requires.

**It does not prove software is correct.** It proves that a precisely identified
artifact satisfied a precisely identified executable policy under a precisely
identified environment. That claim is narrower and far harder to attack.

```
Worker agent                 Averray Witness              Platform
------------                 ---------------              --------
claims job                   receives immutable inputs    holds escrow
produces change   ────────▶  runs verification            validates receipt
submits artifact             emits typed receipt          settles or escalates

The worker earns. The Witness verifies. The platform settles.
```

That separation is the trust architecture, not an implementation detail.

## 2. What it never does

Claim work. Earn a bounty. Hold a wallet, key or signer. Open pull requests. Decide
who gets paid. Change acceptance criteria. Make subjective judgements. Promote its
own verifier changes into production.

The platform may **require** a `PASS` receipt before settlement. The Witness itself
never touches settlement.

## 3. The four duties

### 3.1 Verifiability preflight, at job creation

Before a bounty becomes claimable, determine whether it can be checked at all.

- Can the repository be materialized completely offline?
- Is the toolchain present? Are dependencies in the bundle, lockfile cache or image?
- Does the proposed command exist, and does it currently pass or fail on the base revision?
- Can the candidate modify the command that will judge it?
- Which paths must be protected?
- Is the acceptance criterion deterministic, or does it need human or external judgement?

Result is one of: `EXECUTABLE`, `PARTIALLY_EXECUTABLE`, `HUMAN_REQUIRED`,
`NOT_VERIFIABLE`, `INVALID_JOB`.

This is what stops bounties reaching settlement with criteria like "improve the code"
or "make it production ready". A model may *propose* a Verification Contract from
natural language; the creator or platform must approve and freeze it before workers
see the job.

### 3.2 Independent submission verification

Per candidate: verify the bundle, base tree, candidate tree and contract hashes;
create a **clean baseline environment** and a **separate clean candidate environment**;
run baseline checks; apply the candidate exactly; enforce allowed and protected paths;
run mandatory checks plus any committed hidden checks; repeat per the flakiness policy;
assemble evidence; return a typed verdict.

Baseline and candidate must run in separate clean environments — state left by the
first run otherwise contaminates the second.

The authoritative output is the structured receipt. A prose explanation may accompany
it and is never authoritative.

### 3.3 Replay and dispute resolution

A challenged verdict is re-runnable because every input is content-addressed. A replay
request carries the original bundle, candidate, contract, worker image and evidence,
plus optional counterexample evidence, and returns one of:
`ORIGINAL_VERDICT_REPRODUCED`, `ORIGINAL_VERDICT_NOT_REPRODUCED`,
`NEW_COUNTEREXAMPLE_CONFIRMED`, `DISPUTE_POLICY_INVALID`, `REPLAY_INCONCLUSIVE`.

A challenge should carry **executable** evidence — a failing test — not written
disagreement. High-value jobs may require a second run on a different host, a second
verifier image, a randomly selected independent verifier, or a challenge window before
settlement.

### 3.4 The factual record for reputation

The Witness **does not compute reputation**. It emits the facts reputation is derived
from; the platform aggregates. If it scored agents directly it would be making the
judgements it is forbidden to make.

A badge stops meaning "completed 50 jobs" and starts meaning: 42 reached `PASS`,
37 on first submission, 39 reproduced, 2 reversed after counterexamples, 1
protected-path violation, 18 verified at differential level, 8 against hidden checks,
no sandbox-policy violations.

**The Witness is measured by the same data**: replay agreement rate, verdict reversal
rate, infrastructure-error rate, flakiness-detection rate, evidence completeness,
sandbox-policy compliance. A referee whose overturned calls are public and countable
is a referee that can be trusted. Nobody grades themselves.

## 4. Four verdicts, not two

| Verdict | Meaning |
|---|---|
| `PASS` | Candidate satisfied every mandatory part of the frozen contract |
| `FAIL` | Ran correctly, did not satisfy the contract |
| `INCONCLUSIVE` | The verifier cannot make a valid decision — flaky suite, missing dependency, host failure, resource limit, baseline mismatch, disagreement across repetitions |
| `POLICY_VIOLATION` | Attempted something explicitly prohibited — protected path, replaced runner, disabled checks, escaping symlinks, forbidden system access |

A binary result is inadequate once money is involved. A check forced to produce a
verdict will produce a wrong one.

**`INCONCLUSIVE` must not damage worker reputation or slash a bond — and that makes it
an attack surface.** A worker facing `FAIL` is better off inducing `INCONCLUSIVE`.
The contract must therefore distinguish:

- **infrastructure-attributable** — host died, image unavailable, platform timeout. No
  worker consequence, ever.
- **candidate-attributable** — the submitted change introduced the flakiness, the fork
  bomb, the timeout. No immediate penalty, but it is a *counted signal*; repeated
  candidate-attributable inconclusives from one worker are themselves evidence.
- **contract-attributable** — a frozen premise was false, such as a mismatched source
  binding or a baseline that did not have the declared state. No worker consequence.
- **verifier-attributable** — the Witness lacks enough evidence to decide, such as a
  detector that cannot distinguish a test refactor from a removal. No worker
  consequence; emit an evidence-completeness signal for the Witness's own public
  reputation trail.

Without that split, the humane design becomes the exploit.

## 5. Assurance levels, replacing "verifier types"

Today's four handlers are presented as unrelated alternatives. They are levels.

| Level | Name | What it actually proves |
|---|---|---|
| AV-0 | Declared | The submission has the expected shape or text |
| AV-1 | Executed | A pinned command ran and passed |
| AV-2 | Differential | A defined condition failed on base and passed on candidate |
| AV-3 | Adversarial | The candidate resisted checks it did not control |
| AV-4 | Reproduced | The result was reproduced outside the original execution |

Human review is an orthogonal overlay, not a rung: `AV-2 + HUMAN`.

**AV-2 is the first level that means anything.** Base green → candidate green shows
only that no covered regression was observed. Base *fails the targeted check* →
candidate passes it, and the full suite passes, is a real claim.

**Economics cap this in practice.** Two clean environments × repetitions × a second
verifier costs more compute than a 1 USDC bounty is worth. Assurance is tied to
bounty value, which means the current low-value board stays at AV-0/AV-1. The Witness
raises the ceiling on high-value work; it does not fix the long tail. Say so plainly
rather than implying universal coverage.

## 6. Anti-gaming — what the Witness must detect

Test-manipulation is the primary attack, and none of it is currently caught:

- rewriting the test command (`"test": "echo ok"`)
- deleting failing tests
- adding `skip` / `xfail` / `only` / `focus`
- replacing assertions with no-ops
- rewriting snapshots to accept defective behaviour
- weakening runner configuration, or excluding changed files from lint/coverage
- modifying CI or verifier files
- swallowing errors to force a zero exit code

Candidate-provided tests are useful evidence but must never be the *only* evidence
controlled by the candidate.

**Hidden checks need their own gate.** A hidden test committed by hash before the
worker sees the job is still an LLM artefact and can simply be wrong — producing a
confident false `FAIL`, the most expensive failure mode. A hidden check is only
eligible to judge once it has passed against a known-good reference solution.

## 7. Materialization — the real ceiling

Most real JS/TS repositories cannot build under `--network none` without a
pre-populated dependency closure. This is the practical limit on everything above and
must be stated in the contract, not discovered at verification time.

Status values: `HERMETIC`, `FROZEN_DEPENDENCIES`, `MOCKED_EXTERNAL_SYSTEM`,
`REQUIRES_NETWORK`, `UNMATERIALIZABLE`.

Jobs marked `REQUIRES_NETWORK` use a different verifier class or receive a signed,
immutable evidence snapshot. **The fraction of real repos that are materializable is
unmeasured, and it determines whether this is a platform primitive or a niche tool.**
Phase 1 measures it.

## 8. Profile separation

One kernel, four operationally distinct roles — separate images, service identities,
queues, policy digests, release procedures and audit histories.

| Profile | May modify candidate | Model in verdict path | Purpose |
|---|---|---|---|
| `averray-solver` | yes | yes | Produce a candidate solution |
| `averray-witness` | **no** | **no** | Execute a frozen contract |
| `averray-verifier-planner` | no | yes | Propose a contract before publication |
| `averray-reproducer` | no | no | Independently replay a receipt |

A solver may verify its own work as a pre-submission check. Marketplace settlement
requires a separate Witness run. Local discipline is not independent verification.

## 9. Keep the model out of the verdict path

After the contract is frozen:

```
immutable inputs + frozen policy + pinned environment
                        ↓
              deterministic executor
                        ↓
                 typed receipt
```

A model is valuable for understanding a task, proposing tests, locating files and
explaining failures. An LLM observation such as "the implementation appears correct"
must never affect automatic settlement.

## 10. Self-improvement governance

Verified against the kernel on 2026-08-16:

- `skill promote` and `proposal approve` both require `--affirm OPERATOR`, enforced
  with a raise on empty.
- Promotion binds evidence: it rejects unless the evaluation report matches the
  candidate by **both** ref and hash, and refuses a non-green report.
- No auto-promotion path exists anywhere in the kernel.
- A sandboxed run cannot reach the promotion function: no network, no database, no CLI.
- The green predicate is **hardcoded kernel source**, not candidate-supplied, so a
  proposal cannot move its own goalposts.

Two gaps remain, and both matter for a settlement-authorizing component:

**`affirmed_by` is recorded, not authenticated.** It is a non-empty string. Fine while
one operator runs the CLI; insufficient once promotion is remote or automated.

**The existing improvement predicate is wrong for a verifier.** Today a change is green
if it improves success rate **or** cuts tokens **or** cuts cost **or** gets faster:

```python
if not (success_rate_delta > 0 or tokens_total_delta < 0
        or cost_total_delta < 0 or median_wall_seconds_delta < 0):
    failures.append("no_measured_improvement")
```

**A verifier that checks less is cheaper and faster, and would pass this as an
improvement.** Fewer repetitions, shorter timeouts, skipping the baseline — all
register as green. The Witness therefore needs its own predicate in which the only
permitted improvements are coverage, detection rate and evidence completeness, and in
which a cost or latency reduction accompanied by reduced verification depth is
disqualifying.

Until that predicate exists, the Witness profile must not use the proposal loop at all.

## 11. Receipts need authentication, not just addressing

Content-addressing proves a blob has not changed. It does not prove who produced it,
which verifier version did, that it belongs to this job, or that it was not withheld.

The sandbox keeps no keys — that boundary stays. A separate platform attestation
service validates run metadata, signs the receipt digest, and the platform anchors
signer, job, policy hash, candidate hash, verdict and receipt hash.

Align with in-toto Statement v1 binding a custom Averray predicate to immutable
subject digests; SLSA's Verification Summary Attestation is the closest existing model.

## 12. Sandbox hardening

Once `shell.run` executes untrusted repository code, the **sandbox** is the security
boundary, not the capability broker. The broker governs what the agent may request;
it does not govern what the repository's own code does.

Minimum for public adversarial submissions: rootless runtime, non-root process, all
unnecessary capabilities dropped, `no-new-privileges`, restrictive seccomp, AppArmor
or SELinux confinement, read-only root filesystem, read-only input mounts, no Docker
socket, no host devices or credentials, CPU/memory/process/disk/inode limits, hard
wall-clock timeout, fork-bomb protection, output-size limits, symlink and traversal
protection, an isolated node pool.

Current state is plain Docker with `--network none`. Adequate for trusted repos;
**not** adequate for permissionless public bounty code with meaningful payouts, where
gVisor, Kata or a microVM boundary belongs in the target architecture.

## 13. Where it fits, and where it does not

**Strong fit:** bug fixes, features with executable acceptance tests, dependency
updates, build repairs, type and lint corrections, test additions, deterministic data
transformations, schema migrations, code generation, reproducible benchmarks with a
noise policy.

**Partial fit — verifiable only against a frozen evidence pack:** Wikipedia citation
work, open-data catalogue updates, standards drift, research extraction. The Witness
can confirm a citation points to a *supplied* source, or a dataset contains a
specified record. It cannot establish that a source is live or authoritative without a
network-capable evidence acquisition component.

**Poor fit for automatic settlement:** design quality, architectural elegance, legal
correctness, source credibility, persuasiveness, whether software is "secure", whether
a current external fact is true, absence of undiscovered bugs.

One qualification on the last: a security *verdict* is unverifiable, but specific
security **invariants** are cheap and mechanical — no new dependencies, no `eval`, no
outbound calls, no writes outside allowed paths. Those belong in contracts, because
they are exactly what a poster worries about when accepting a stranger's patch.

## 14. Staged rollout

**Phase 1 — Materialization preflight.** Build duty 3.1's first component and answer
the ceiling question by building the product rather than researching it. Over a real
corpus of candidate repos, report the `HERMETIC` / `FROZEN_DEPENDENCIES` /
`REQUIRES_NETWORK` / `UNMATERIALIZABLE` distribution and the cost per repo.

**Phase 2 — Shadow Witness.** Run against existing submissions, controlling nothing.
Qualification corpus: correct patches, incorrect patches that still pass, deleted
tests, modified test commands, skip/xfail attacks, protected-path changes, flaky
suites, timeouts and fork bombs, missing dependencies, malformed patches, escape
probes, previously verified receipts for replay. Measure false passes, false failures,
inconclusive rate and replay agreement.

The 14-day unattended burn-in does **not** substitute for this. Unattended execution
and trustworthy verification are different qualification claims.

**Phase 3 — `code_change` job type.** First-class, requiring bundle hash, base tree
hash, contract, toolchain image, protected paths, settlement policy and verification
level. Only these receive automatic Witness verification.

**Phase 4 — Settlement gating.** Require AV-2 or better for automatic code-bounty
payout. `PASS` → eligible; `FAIL` → reject or resubmit; `INCONCLUSIVE` → pause without
penalty; `POLICY_VIOLATION` → reject, slash only under explicit rules.

**Phase 5 — Challenge and replay.** Bonded executable counterexamples, independent
replays, mandatory second verification for high-value jobs.

**Phase 6 — Verifier network.** Independently operated verifier nodes implementing the
same contract and receipt formats. At that point Averray is a protocol for competing
workers and independently reproducible verification, not a marketplace with one
trusted verifier.

## 15. What is measured, and what is assumed

| Claim | Status |
|---|---|
| Agent repairs a real defect offline and proves it with the repo's own suite | measured — 6/6, regression tests self-authored |
| Promotion cannot happen without a named operator and a green, hash-bound report | measured — kernel source, 2026-08-16 |
| Fraction of real repos materializable offline | **unmeasured** — Phase 1 |
| Whether differential checking flips verdicts versus today's handlers | **unmeasured** — Phase 2 |
| False-pass and false-fail rates against an adversarial corpus | **unmeasured** — Phase 2 |

Nothing below the line gets claimed in product language until it is above it.
