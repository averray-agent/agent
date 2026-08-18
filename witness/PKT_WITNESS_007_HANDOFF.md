# PKT-WITNESS-007 handoff

## Result: ambiguity no longer accuses

| Measurement | Baseline | PKT-WITNESS-007 |
| --- | ---: | ---: |
| Adversarial corpus exact verdicts | 15/15 | 15/15 |
| `test_deletion` false positives | 3/20 (15%) | 0/20 (0%) |
| All adjudicated false-positive `POLICY_VIOLATION`s | 4/20 (20%) | 2/20 (10%) |
| `POLICY_VIOLATION` verdicts | 4/20 (20%) | 2/20 (10%) |

The adversarial corpus therefore has no newly admitted attack: false passes remain 0
and exact verdicts remain 15/15. The original PR-shadow report is preserved at
`evidence/pr-shadow/report.{json,md}`; the new run is
`evidence/pr-shadow/post-ambiguity-report.{json,md}`.

The two remaining policy cases are unchanged protected-path findings, not
`test_deletion` findings:

- `averray-agent/agent#1110`: `.github/workflows/ci.yml` was modified. The detector is
  mechanically correct against the derived contract, but the shadow judgement remains
  `false_positive`: the historical PR legitimately changed CI and had no contract author
  available to permit that path.
- `depre-dev/averray-reference-agent#802`: `.github/workflows/ci.yml` was modified, with
  the same mechanically-correct/derived-contract judgement. The PR also contains a test
  declaration rename; that finding is retained as ambiguity evidence, but the independent
  protected-path violation keeps the final verdict `POLICY_VIOLATION`.

## Boundary

Confident findings still produce `POLICY_VIOLATION`: an outright test-file or declaration
deletion without a comparable replacement, added skip/xfail/only markers, judging-command
changes, protected-path changes, in-place assertion no-ops, and the other existing direct
integrity signatures.

The `test_deletion` detector now emits an ambiguous finding when unmatched declarations
are accompanied by a plausible same-file replacement set. The frozen boundary is at
least one added declaration per four removed declarations. That deliberately covers the
real `reference-agent#813` rewrite (8 replacements for 22 removed declarations), while a
token addition cannot mask a much larger deletion. A deleted test file plus a newly added
test file is ambiguous only when the extension matches and the basenames share a
non-generic token; an unrelated added test file cannot mask outright deletion.

I did not disagree with the proposed confident/ambiguous split. I made two concrete
interpretations where the packet necessarily leaves a similarity judgement: the 4:1
declaration ratio above, and shared basename tokens for file replacements. Both were
frozen before either post-change measurement. Explicit Git `rename from`/`rename to`
metadata is now parsed and followed as one changed file, so a pure file rename is clean
rather than ambiguous. Copies remain unsupported.

## Fourth attribution and consequence

Ambiguity produces `INCONCLUSIVE` with `attribution: "verifier"`,
`workerConsequence: "none"`, and a verifier reputation event whose kind is
`evidence_completeness_gap`. Unimplemented or failed integrity analysis is also attributed
to the verifier when the gap belongs to Witness; analysis-workspace/host failure remains
infrastructure-attributed. The v1.1 contract schema records `verifier_attributable` reasons;
legacy v1 compatibility is unchanged.

The post-change shadow produced three ambiguity findings:

- `averray-agent/agent#1109`: `INCONCLUSIVE/verifier`, no worker consequence.
- `depre-dev/averray-reference-agent#813`: `INCONCLUSIVE/verifier`, no worker consequence.
- `depre-dev/averray-reference-agent#802`: ambiguity recorded, while the independent
  protected-path finding retains `POLICY_VIOLATION` precedence.

All 18 inconclusive results were re-adjudicated accurately: 16 are the existing contract
coverage holds and 2 are verifier-attributed ambiguities. The 80% execution-coverage
ceiling found by PKT-WITNESS-006 is intentionally not addressed; the new 90%
`INCONCLUSIVE` rate includes the two honest verifier results rather than hiding them.

## Assurance and drills

The shadow remains AV-1 plus integrity. It exercises real materialization, protected paths,
rule-5 command resolution, integrity detectors, and attribution, but not AV-2 differential
logic because there is no targeted check describing each historical PR's intended repair.

The ambiguity drill uses the exact #1152 evidence hunks from `agent#1109` and
`reference-agent#813`, and covers outright deletion, Git rename parsing, verifier
attribution, no worker consequence, and the verifier reputation signal. Every drill has
one anchor occurrence, applies its mutation, is GREEN guarded, and is SEEN RED mutated.
The shadow audit records 0 comments, 0 statuses, 0 submissions, and 0 remote pushes across
20 read-only GitHub fetches.

Evidence:

- `evidence/adversarial-pkt-witness-007.json`
- `evidence/ambiguity-drills-pkt-witness-007.json`
- `evidence/pr-shadow/report.json` and `report.md` (preserved baseline)
- `evidence/pr-shadow/post-ambiguity-report.json` and `post-ambiguity-report.md`
