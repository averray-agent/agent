# PKT-WITNESS-009 handoff

## Headline: 11 implementation artifacts closed, 5 structural

The original 16 `INCONCLUSIVE` results split into:

- 11 implementation artifacts, all now decided: six missing-`uv` Harness cases
  and five HTTP-smoke timeouts.
- 5 structurally undecidable cases: four require a privileged Docker/database
  service and one requires a private CI credential. Neither is safe to expose to
  stranger code or legitimate to fabricate in the shadow harness.
- 0 unresolved implementation artifacts from the original 16.

The updated coverage is **13/20 decided**. That is 11 `PASS`, 2 retained
`POLICY_VIOLATION`, and 7 `INCONCLUSIVE`. The two policy results are the existing,
human-adjudicated false positives, so “13 decided” is a coverage statement, not a
claim that all 13 decisions are correct. The seven residual inconclusives are the
five structural cases above plus two conservative verifier-semantic ambiguities
introduced by #1154.

## Coverage history on the same 20 PRs

| Measurement | Decided | INCONCLUSIVE | Note |
| --- | ---: | ---: | --- |
| #1152 baseline | 4/20 | 16/20 | Preserved original measurement |
| Current main (#1155, including the #1154 regression) | 2/20 | 18/20 | Rule 5 relaxation exposed the next blockers; two false policy results became verifier ambiguities |
| PKT-WITNESS-009 | 13/20 | 7/20 | 11 artifacts removed; no threshold change |

The comparison generator rejects mismatched cohort IDs, so all three rows name the
same frozen 20 PRs.

## Cause 1: uv — 6/6 now decided

The sandbox image copies `/uv` and `/uvx` from the official
`ghcr.io/astral-sh/uv:0.12.5` image pinned at multi-platform manifest digest
`sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1`.
The Dockerfile explains why the extra tool belongs in the adversarial image.

A fresh-cache drill exposed that the Harness lock requires Python 3.12.12; the
earlier exploratory cache had hidden this by retaining a uv-downloaded interpreter.
The final image therefore also copies Python 3.12.12 from the official
`python:3.12.12-slim-bookworm` image pinned at multi-platform manifest digest
`sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c`.
Interpreter downloads remain disabled in both dependency phases.

The Harness also declares exact build backend `uv_build==0.9.27`, which uv does not
record in `uv.lock`. The image embeds that backend from binary wheels only, pinned
to PyPI's three compatible Linux amd64/arm64 SHA-256 hashes. The offline phase creates
the project environment, installs the matching wheel with
`--no-index --require-hashes`, then uses `--no-build-isolation`. An unknown or
mismatched `[build-system]` is rejected before this pinned path is selected, rather
than silently using the image's backend or downloading one while repository code has
egress. Check execution sets `UV_NO_SYNC=1` so a repository's
own `uv run` consumes that already locked and prepared environment instead of
silently attempting a second dependency resolution under `--network none`.

For `pyproject.toml` plus `uv.lock`, Phase 1 populates uv's exact locked cache with
`--no-install-local --no-build`, so repository/workspace code and source build
backends cannot execute during the network-capable phase. That phase installs into
a throwaway `/tmp` environment. The repository environment is then created with
`UV_OFFLINE=1` and `UV_PYTHON_DOWNLOADS=never`; local project build code may run only
inside that no-egress phase. The project virtual environment is put on `PATH`. The six Harness
cases #36, #35, #32, #31, #30, and #29 all changed from `INCONCLUSIVE` to `PASS`.

The image also contains `zsh`, a canonical reference-agent gate prerequisite. It
allowed the gate to progress far enough to expose its real service/credential
boundaries rather than stopping at a missing shell.

## Cause 2: HTTP smoke — 5/5 now decided

These checks are **not network-dependent**. Across the five measured base/head
pairs, `mcp-server/src/protocols/http/server.smoke.test.js` is the identical Git
blob `d2fb2db40512d0cdaea8e614c2e51be82bce04f1`; its active server requests use
`127.0.0.1`. The external-looking URLs in its fixtures are payload data, not the
transport used by the checks.

The timeout was host filesystem virtualization. On the macOS/Colima bind mount,
the file-level smoke suite reached its 60-second deadline. In the container's
quota-backed tmpfs it completed normally, with Docker reporting `NetworkMode=none`
and the process seeing only `lo`. Cases #1149, #1148, #1147, #1146, and #1145 all
changed from `INCONCLUSIVE` to `PASS`.

The shadow runner now mounts its prepared tree read-only at `/averray-source`, copies
it into a 3 GiB `/workspace` tmpfs, and runs there. Cache population remains the only
bridge-network phase. Every recorded check attempt in the final shadow report uses
`networkMode: none`; the implementation-ceiling drill separately inspects Docker's
live `HostConfig.NetworkMode` and the interfaces inside the container.

The CPU ceiling moved from two to four CPUs to match public GitHub-hosted Linux
runners while remaining explicitly bounded. Four CPUs alone did not fix the smoke
timeout (42 tests completed before the same deadline); the tmpfs workspace did.

## Cause 3: missing CI prerequisites — 0/5 decided, now typed structural

The shadow manifest now supplies the legitimate repository-owned prerequisites:
`npm run typecheck`, Git metadata for gates that inspect repository state, and the
`zsh` tool used by the canonical gate. It does not supply unsafe or private CI state.

| Case | Typed subcause | Observed boundary |
| --- | --- | --- |
| reference-agent #816 | `requires_ci_service` | INT4B/INT4C database startup needs Docker; the run also exposes private Harness checkout, INT4D checkout-state, process-reaping, and run-container inventory assumptions |
| reference-agent #815 | `requires_ci_service` | Same canonical INT4 database, private checkout, process, and container prerequisites as #816 |
| reference-agent #814 | `requires_ci_service` | Same canonical INT4 database, private checkout, process, and container prerequisites as #816 |
| reference-agent #812 | `requires_ci_service` | Same canonical INT4 database, private checkout, process, and container prerequisites as #816 |
| reference-agent #603 | `requires_ci_credential` | Authenticated SSH clone of the private pinned Harness |

These five are structural under the Witness threat model. Mounting the host Docker
socket would hand adversarial code control of the host security boundary; providing
a deploy key would disclose a private credential. The Witness does neither. Worker
consequence remains none for these inconclusive shadow outcomes.

No ordinary environment variable or missing public fixture remained after the
legitimate typecheck/build preparation, Git metadata, `zsh`, and `uv` were supplied.
The remaining “fixture” is the private pinned Harness checkout itself; faking it
would no longer be execution of the repository's canonical CI precondition.

This corrects #1155's provisional “0 structural” headline. That diagnosis was true
only of the first blockers then visible. Once legitimate tooling and preparation
were supplied, five second-order blockers proved structural.

## Check-level network classification

A check that emits a real egress-failure signature under `NetworkMode=none` is now
typed `check_requires_network`, structural, after one offline check attempt. It is
not silently retried online. None of the five cohort HTTP-smoke cases entered that
path; a deterministic network-required fixture proves it independently.

## Regression bar and drills

| Check | Result |
| --- | ---: |
| Adversarial exact verdicts | 15/15 |
| Adversarial false passes | 0 |
| Detector false-positive rate | 0% |
| Policy false-positive rate | 10% (unchanged) |
| Authored `make` contract | Rule 5 rejection retained |
| Witness unit tests | 96/96 |
| Observed shadow check network modes | `none` only |

The PKT-009 drill covers the pinned uv binary and a Python check, Docker's live
no-egress state, and a genuine check-level network dependency with no retry. Every
mutation records `anchorOccurrences: 1`, `applied: true`, a GREEN real path, and a
RED mutated path. Prior coverage, PR-shadow, and detector-ambiguity mutation suites
also remain GREEN/SEEN RED with the same anchor guards.

Evidence:

- `evidence/pr-shadow/implementation-ceiling-report.{json,md}`
- `evidence/pr-shadow/implementation-ceiling-comparison.json`
- `evidence/implementation-ceiling-drills-pkt-witness-009.json`
- `evidence/pr-shadow/coverage-diagnosis-drills-pkt-witness-009.json`
- `evidence/pr-shadow/drills-pkt-witness-009.json`
- `evidence/ambiguity-drills-pkt-witness-009.json`
- `evidence/adversarial-pkt-witness-009.json`

No schema, detector threshold, receipt, replay, reputation, settlement, worker, or
money-rail behavior changed.
