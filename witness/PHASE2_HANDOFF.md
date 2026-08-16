# PKT-WITNESS-003 handoff

## Scope delivered

- `bin/verify.mjs` executes `averray.verification-contract/v1` against a Git patch and
  emits `averray.witness.verification-result/v1`.
- Static candidate policy and all seven declared integrity detectors run before any
  execution blocker, preserving `POLICY_VIOLATION > INCONCLUSIVE > FAIL > PASS`.
- Baseline and candidate use clean copied workspaces and distinct container IDs for
  every repetition. CPU, memory, process, time, output, read-only-root, non-root,
  capability, privilege, and network controls are recorded.
- The deterministic adversarial corpus now contains 15 cases against the exact tracked
  snapshot of `depre-dev/averray-send-test` commit
  `42571061ca9b6da8c6aca908f1ee1df1dab4e10a`.

Receipts, digests, signing, attestation, replay, storage, dispute, reputation, worker,
money rail, and settlement integration are absent.

## Corpus result

Rows are expected; columns are actual in `PASS, FAIL, INCONCLUSIVE,
POLICY_VIOLATION` order.

| Executor / expected | actual PASS | actual FAIL | actual INCONCLUSIVE | actual POLICY_VIOLATION |
|---|---:|---:|---:|---:|
| Real / PASS | 1 | 0 | 0 | 0 |
| Real / FAIL | 0 | 2 | 0 | 0 |
| Real / INCONCLUSIVE | 0 | 0 | 3 | 0 |
| Real / POLICY_VIOLATION | 0 | 0 | 0 | 9 |
| Naive / PASS | 1 | 0 | 0 | 0 |
| Naive / FAIL | 0 | 2 | 0 | 0 |
| Naive / INCONCLUSIVE | 0 | 0 | 3 | 0 |
| Naive / POLICY_VIOLATION | 7 | 2 | 0 | 0 |

- Real: 0 false passes, 0 false fails, 3/15 inconclusive (20%), attribution
  accuracy 3/3 (100%), exact verdicts 15/15.
- Naive: 7 false passes, 0 false fails, 3/15 inconclusive (20%), attribution
  accuracy 3/3 (100%), exact verdicts 6/15.
- Qualification: those false-pass counts cover represented detectable classes only.
  The emitted matrix names six known-undetectable semantic/framework classes that are
  deliberately not represented.
- Isolation drill: four unique baseline and four unique candidate container IDs for
  the correct-fix case, with no overlap.
- Precedence drill: the test-deletion patch that still fails the targeted check is
  `POLICY_VIOLATION` in real mode and `FAIL` in naive mode.

## Integrity support and mutation drills

Every detector has an adversarial patch yielding a named `POLICY_VIOLATION`, a paired
safe patch yielding `PASS`, and a confirmed one-anchor mutation yielding the expected
`RED` when disabled:

- `test_deletion`
- `skip_or_xfail_markers_added`
- `runner_replacement`
- `assertion_neutering`
- `snapshot_rewrite_to_accept_current`
- `coverage_or_lint_exclusion_of_changed_files`
- `error_swallowing_to_force_zero_exit`

The first three are structural within their stated JavaScript/pytest and resolved-runner
scope. Snapshot rewriting rejects changes to existing `*.snap` and `__snapshots__`
files. Assertion, exclusion, and error-swallowing detectors reliably reject their
published signatures, but arbitrary semantic equivalents cannot be made reliable with
static patch matching. Those gaps are marked `unimplemented` in the result metadata.

## VerificationContract v1 draft defects encountered

1. The worked instance names base commit
   `4257106b9e3f2a8d15c74e0b6a93df82c105e7d4`; the seeded repository's actual pinned
   commit is `42571061ca9b6da8c6aca908f1ee1df1dab4e10a`.
2. Its targeted command, `node --test --test-name-pattern unitless`, exits zero on the
   unchanged base because Node treats the absence of matching tests as skipped tests.
   It therefore contradicts `expected_on_base: fail`. The corpus does not alter the
   example; it uses a contract-owned direct assertion so the differential is real.
3. `bundle_sha256` has neither a canonical source-bundle algorithm nor an artifact
   locator, so the executor can pin the Git commit but cannot verify that field.
4. Dependency-cache and frozen-input records contain hashes but no acquisition
   location or archive/mount format. Phase 2 therefore cannot materialize
   `FROZEN_DEPENDENCIES` or `MOCKED_EXTERNAL_SYSTEM` from the contract alone.
5. A hidden bundle has a digest and eligibility reference but no locator, archive
   format, or command manifest. A required hidden bundle fails closed as
   infrastructure-attributable `hidden_bundle_unavailable`.
6. `writable_storage_mb` cannot quota the candidate's read-write bind mount with the
   v1 Docker layout. It is enforced for `/tmp` only and reported as such.
7. Check commands have no working-directory field; v1 necessarily assumes repository
   root.

The open contract-digest algorithm remains untouched.

## Commands

```sh
npm --prefix witness test
npm --prefix witness run integrity:drills
node witness/bin/run-adversarial-corpus.mjs --quiet --out /tmp/adversarial-corpus.json
node witness/bin/verify.mjs --contract <file> --candidate <patch> --out <result>
```
