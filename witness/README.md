# Averray Witness materialization preflight

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
```

The drills compare a deliberately static inference with actual sandbox execution.
They cover a genuine network dependency, a missing toolchain, a lockfile-plus-test
script that still needs network, and an in-container `NetworkMode none` assertion.

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
