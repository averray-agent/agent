# Averray Witness

Phase 1 of the [Averray Witness architecture](../docs/AVERRAY_WITNESS_ARCHITECTURE.md)
answers one question before a job is published: can the base repository and its
frozen check command actually run without network access?

The preflight classifies by executing. Repository metadata selects a toolchain and
a possible dependency-preparation path; it never decides the classification by
itself.

## Usage

```sh
node witness/bin/preflight.mjs \
  --repo averray-agent/agent \
  --check "npm test" \
  --out report.json

node witness/bin/preflight-summary.mjs reports/
```

`--repo` accepts a Git URL, a GitHub `owner/repo` slug, or a local path. Useful
optional inputs are:

- `--timeout <seconds>`: per-container hard timeout (default 300).
- `--protected-path <path>`: a path the candidate may not edit. Repeatable.
- `--frozen-input <path>`: a declared local replacement for an external input.
  Repeatable; each input is hashed into the report.
- `--image <name>`: local Witness image override. The resolved image ID is pinned
  into the run and report.

The JSON report records the repository and commit, detected toolchain and evidence,
classification, command existence, base exit status, command-definition path and
candidate modifiability, cache size and preparation time, every observed attempt,
and a failure reason for `REQUIRES_NETWORK` and `UNMATERIALIZABLE`.

A non-zero base exit status does not automatically make a repository
unmaterializable. If the test suite genuinely ran offline and failed an assertion,
the materialization classification can still be `HERMETIC` or
`FROZEN_DEPENDENCIES`; the failed base status separately says the check is not a
usable acceptance criterion as-is.

## Execution boundary

1. Git clone and submodule acquisition happen host-side. Local targets are copied;
   they are never modified.
2. Cache population is the only dependency phase allowed network access. For npm it
   runs `npm ci --ignore-scripts`; repository lifecycle scripts do not execute in
   that network-capable phase.
3. Dependency installation and the check run in the distinct Witness image with
   `--network none`, a read-only container root, non-root UID, all capabilities
   dropped, `no-new-privileges`, and CPU/memory/process/time limits.
4. Before every offline command, code inside the container enumerates
   `/sys/class/net`. The run is rejected unless only loopback is visible. Docker's
   observed host-side `NetworkMode` is recorded as an additional check, not trusted
   on its own.
5. The exact local image ID resolved before the first attempt is used for every
   subsequent attempt.

No worker identity, wallet, claim, submission, PR, or settlement code is present in
this package.

## VerificationContract execution

Phase 2 executes a frozen contract and a Git patch to a typed verdict:

```sh
node witness/bin/verify.mjs \
  --contract contract.json \
  --candidate candidate.patch \
  --out verification-result.json
```

Exit codes are `0` for `PASS`, `1` for `FAIL`, `2` for `POLICY_VIOLATION`, and
`3` for `INCONCLUSIVE`. The JSON result names every policy/integrity detection and
attributes every inconclusive verdict to `infrastructure`, `contract`, or `candidate`.
Every inconclusive result records `workerConsequence: "none"`.

The executor materializes the exact base commit, validates and applies the patch with
Git isolated from any parent worktree, and uses separate source copies and container
IDs for baseline and candidate repetitions. It confirms targeted checks fail on base,
then runs targeted checks before regressions on the candidate. Verdict precedence is
`POLICY_VIOLATION > INCONCLUSIVE > FAIL > PASS`.

Legacy v1 execution remains limited to `HERMETIC` materializations because its bare
digests have no acquisition data. v1.1 artifacts carry SHA-256, byte length, locator,
and format. Source uses a full `git-bundle`: before any baseline container, Git verifies
its object graph, its only advertised ref must equal `base_commit`, and that commit is
checked out offline. Caches, frozen inputs, and supplied hidden tests are verified
before use. Supplied tests and other frozen artifacts are nested read-only mounts in
every baseline and candidate workspace. `temporary_storage_mb` limits the `/tmp` tmpfs.
v1.1 deliberately declares no workspace quota because Docker cannot quota the
read-write bind mount used for the candidate workspace.

All seven declared integrity names execute. Structural cases are covered for removed
JavaScript tests, added JavaScript/pytest skip markers, changed resolved runner files,
and tracked snapshot files. Assertion neutering, coverage/lint exclusions, and error
swallowing use named syntactic signatures; semantic variants hidden in arbitrary helper
code remain explicitly listed as unimplemented in each result's `integritySupport`
metadata rather than being presented as universal static analysis.

## VerificationContract v1/v1.1 freeze validation

The schema directory contains the immutable v1 schema and
[`verification-contract-v1.1.schema.json`](schema/verification-contract-v1.1.schema.json).
The loader and validator live in
[`src/verification-contract.mjs`](src/verification-contract.mjs):

- `loadVerificationContract(path)` reads, normalizes, and validates a JSON file.
- `parseVerificationContractJson(json)` does the same for JSON text or bytes.
- `validateVerificationContract(value)` returns the normalized contract and named
  validation issues without throwing.
- `assertValidVerificationContract(value)` returns the normalized contract or throws
  `VerificationContractValidationError`.
- `validateVerificationContractAtFreeze(value)` additionally retrieves artifacts and
  executes every targeted/supplied differential on base.

Static validation is side-effect free. Complete v1.1 freeze validation executes the
base differential in the Docker sandbox. Neither path calculates a contract digest,
writes receipts, stores contracts, or implements replay.

Rule 5 resolves npm, pnpm, and Yarn package scripts to `package.json` and explicit
Node/Python/shell repository scripts to their path.
Direct Node runner commands such as `node --test` have no repository definition file.
Package-manager workspace/relocation forms, Make (which can select or include multiple
definition files), shell command strings, and other command families are rejected when
their defining file cannot be proved.

The eight policy drills show the shape-only baseline accepting each invalid fixture
(`RED`), freeze validation rejecting it with the named rule (`GREEN`), and the same
contract with one field corrected being accepted (`GREEN`):

```sh
npm --prefix witness run contract:drills
npm --prefix witness run v1.1:drills
npm --prefix witness run binding:drills
```

## Phase-1 dependency paths

- Node/npm: `package-lock.json` or `npm-shrinkwrap.json` populates an npm cache;
  install scripts run only during the subsequent offline install. Node headers are
  supplied by the pinned image for offline native builds.
- Python: exact, SHA-256-hash-pinned `requirements*.txt` inputs populate a Linux
  wheelhouse using binary wheels and pip's `--require-hashes`, followed by an
  offline virtual-environment install.
- pnpm, Yarn, Rust, Go, Ruby, Poetry and uv are detected but have no pinned Phase-1
  preparation path. Their observed failures become `REQUIRES_NETWORK` or
  `UNMATERIALIZABLE`, never an implicit host execution fallback.

The command definition is candidate-modifiable when it resolves to a repository
file (for example `package.json`, `Makefile`, or a repository script) and that file
is not protected. With no protected paths supplied, the report explicitly records
the Phase-1 assumption that all repository paths are editable.

## Drills and corpus

```sh
npm run test:witness
npm --prefix witness run drills -- --out evidence/drills.json
npm --prefix witness run corpus -- --out-dir evidence/corpus
npm --prefix witness run integrity:drills
npm --prefix witness run adversarial:corpus -- --out evidence/adversarial-corpus.json
npm --prefix witness run pr:shadow -- --allow-unreviewed --out evidence/pr-shadow/discovery.json
npm --prefix witness run pr:shadow:report -- \
  --input evidence/pr-shadow/discovery.json \
  --out evidence/pr-shadow/report.json
npm --prefix witness run pr:shadow:drills
```

The integrity drill mutates each detector registration in a temporary module. It
requires the mutation anchor to occur exactly once, confirms the replacement was
applied, records the expected `RED`, then checks the attack and its corrected patch
against the real detector.

The 15-case adversarial corpus is pinned to
`depre-dev/averray-send-test@42571061ca9b6da8c6aca908f1ee1df1dab4e10a`.
It runs both the real executor and a deliberately naive checks-only mode and emits an
expected-versus-actual confusion matrix, false passes, false fails, inconclusive rate,
attribution accuracy, and the distinct baseline/candidate container IDs.
The matrix also names six known-undetectable classes that are not represented; its
zero-false-pass claim is explicitly limited to represented detectable classes.

The drills compare a deliberately static inference with actual sandbox execution.
They cover a genuine network dependency, a missing toolchain, a lockfile-plus-test
script that still needs network, and an in-container `NetworkMode none` assertion.

## Merged-PR false-positive shadow

The merged-PR shadow answers the question the adversarial corpus cannot: how often do
the candidate-policy and integrity detectors flag legitimate work? Its frozen 20-PR
manifest spans `averray-agent/agent`, `depre-dev/averray-reference-agent`, and the
private `averray-agent/agent-harness`, including documentation, test-only, refactor,
feature, config, and CI changes. GitHub access is structurally limited to authenticated
GET requests and read-only clones. The runner has no comment, status, submission, or
push operation.

Each PR gets a derived contract containing its base commit, head commit, exact diff
digest, protected paths, all seven integrity detections, and the repository's own
regression check. It deliberately contains no contract author and no targeted check.
The resulting assurance is **AV-1 plus integrity**, not AV-2; differential logic is not
exercised because the shadow does not know what each historical PR was supposed to fix.

The JSON and Markdown reports include the verdict distribution, every individual
`POLICY_VIOLATION` with the causing diff hunk and human judgement, false-positive rates
per detection, materialization/command failures, and reviewed INCONCLUSIVE attribution.
The committed judgement file is separate from detector configuration: findings are
reported and adjudicated, never tuned away. A run exits 2 if any violation or
INCONCLUSIVE attribution remains unreviewed; use `--allow-unreviewed` only for the first
evidence pass that discovers cases to adjudicate.

The ten-repository manifest is [`corpus/repos.json`](corpus/repos.json). It includes
the six packet-mandated repositories plus:

- `expressjs/express`: mature Node suite with no committed npm lockfile on the
  measured revision.
- `pytest-dev/pluggy`: small foundational Python project with a genuine pytest
  suite and an explicit runner-version floor.
- `pallets/click`: widely used Python suite exercising the no-frozen-requirements
  path.
- `BurntSushi/ripgrep`: mature Rust suite exercising typed missing-toolchain
  handling.

Corpus reports are evidence snapshots for the recorded commits, not permanent facts
about the repositories. Rerun the corpus when a target revision, image, or check
command changes.
