# PKT-WITNESS-008 handoff

## Headline: 0 structural, 16 implementation artifacts

None of the original 16 `INCONCLUSIVE` results is structurally undecidable on the
available evidence. All 16 are artifacts of the current Witness implementation:

- 6 first hit over-strict Rule 5 inheritance in shadow mode. Once allowed to run,
  all 6 hit a second implementation gap: `make gate` reached `Makefile:4` and
  failed because the Witness image does not contain `uv`.
- 10 reached their declared base check and errored. Five timed out in the agent
  HTTP-smoke check; five lacked prerequisites that reference-agent CI supplies
  before `npm test` (workspace build outputs, tools, services, or credentials).

The residual ceiling in this cohort is therefore a property of the implementation,
not evidence of an inherent ceiling in real repositories. This does not make the
gate-versus-sampler decision; it says the current 20-PR number is not fit to decide it.

## Coverage on the same 20 PRs

| Measurement | Decided | INCONCLUSIVE | Note |
| --- | ---: | ---: | --- |
| Preserved #1152 baseline | 4/20 | 16/20 | The number named in this packet |
| Current-main baseline after #1154 | 2/20 | 18/20 | Two detector ambiguities were honestly moved out of `POLICY_VIOLATION` |
| PKT-WITNESS-008 | 2/20 | 18/20 | All six Make checks ran; decision gain from the relaxation was 0 |

The apparent 4-to-2 change is not caused by this packet. It is the already-landed
#1154 correction that stopped calling ambiguous test rewrites policy violations.
Against the current-main baseline, this packet is 2/20 to 2/20.

## The original ten unavailable base checks

| Cause | Count |
| --- | ---: |
| No test script at base | 0 |
| Check command undetermined | 0 |
| Base materialization/dependency closure failed | 0 |
| Base check genuinely failed | 0 |
| Base check errored | 10 |
| Base commit unavailable | 0 |

The ten errors split into two distinct subcauses:

- `check_timeout`: 5/10, all `averray-agent/agent` cases. Dependencies prepared
  successfully, then the HTTP-smoke file hit its internal 60-second timeout on
  both head and base.
- `missing_ci_prerequisites`: 5/10, all `depre-dev/averray-reference-agent`
  cases. The recorded failures include missing built workspace exports, `zsh`,
  database/container coupling, and authenticated Harness checkout. The repository's
  CI installs tooling and runs typecheck/build preparation before `npm test`; the
  derived one-command shadow recipe does not reproduce that lane.

After the Rule 5 relaxation, the six Harness cases add six more
`missing_ci_prerequisites` results. They are not included in the original-ten table:
their exact error is `make: uv: No such file or directory` on both head and base.

## Shadow-only boundary

An unresolved definition is runnable only in `pr-shadow.mjs`. Each of the six Make
results records `judgingCommandProtected: false`. The authored contract validator is
unchanged and still rejects `make gate` with
`VCV1_RULE_5_JUDGING_COMMAND_PROTECTED` at freeze.

No detector threshold changed. The 4:1 declaration boundary is now pinned directly:
40 removals/10 additions is ambiguous, while 41/10 is a violation.

## Regression bar and drills

| Check | Result |
| --- | ---: |
| Adversarial exact verdicts | 15/15 |
| Adversarial false passes | 0 |
| Detector false-positive rate | 0% |
| Policy false-positive rate | 10% before, 10% after |
| Witness unit tests | 92/92 |

The PKT-008 mutation drill covers authored Rule 5, the shadow relaxation, timeout
diagnosis, missing-prerequisite diagnosis, genuine-red-base diagnosis, and
materialization diagnosis. Every mutation has `anchorOccurrences: 1`,
`applied: true`, a GREEN normal path, and a RED mutated path. The standard PR-shadow
and ambiguity mutation suites are also GREEN/SEEN RED.

One measurement attempt was rejected before use: a cache under `/private/tmp` was
not shared into Colima, so containers saw empty workspaces. The missing
`package.json`/`Makefile` signatures exposed the bad mount. The run was repeated from
a Docker-shared worktree path, and the invalid temporary cache was removed.

## Remaining implementation defects exposed

This packet diagnoses but deliberately does not repair three executor limitations:

1. The Witness image does not contain the pinned `uv` toolchain used by `make gate`.
2. A single derived command cannot reproduce multi-step CI prerequisites such as
   workspace builds and installed system tools.
3. A missing executable nested under Make currently exits 2 and is initially called
   a hermetic check failure by Phase 1. The diagnostic layer correctly recognizes the
   `make: <tool>: No such file or directory` evidence as an execution error, but the
   preflight interpreter itself still needs a later fix.

No schema changed. No executor behavior, threshold, receipt, replay, reputation, or
settlement logic was added.

Evidence:

- `evidence/pr-shadow/coverage-diagnosis-report.{json,md}`
- `evidence/pr-shadow/coverage-comparison.json`
- `evidence/pr-shadow/coverage-diagnosis-drills.json`
- `evidence/coverage-diagnosis-drills-pkt-witness-008.json`
- `evidence/ambiguity-drills-pkt-witness-008.json`
- `evidence/adversarial-pkt-witness-008.json`
