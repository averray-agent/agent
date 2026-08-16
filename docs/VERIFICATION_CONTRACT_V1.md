# VerificationContract v1

Status: **draft.** Written 2026-08-13, after Phase 1 (#1125) measured the corpus.
Companion to `AVERRAY_WITNESS_ARCHITECTURE.md`.

The contract is the object the Averray Witness executes. It is frozen before a job
becomes claimable, identified by digest, bound into every receipt, and versioned
rather than edited in place.

## Why this shape — the measurement that drove it

Phase 1 ran the materialization preflight over ten real repositories:

| Result | Count |
|---|---|
| `HERMETIC` | 1 |
| `FROZEN_DEPENDENCIES` | 4 |
| `REQUIRES_NETWORK` | 4 |
| `UNMATERIALIZABLE` | 1 |

Five are materializable. **Three of those five already fail on their base revision.**
So of ten real repositories, two are both materializable and base-green — and one of
those is a fixture seeded for the purpose.

Two consequences, and they are the reason v1 does not look like the obvious design:

**A green full suite cannot be the primary acceptance criterion.** Most real suites are
already red. A contract asserting "the suite passes" returns `FAIL` for reasons the
candidate never touched.

**The targeted differential check is the default, not the upgrade.** A check that fails
on base and passes on candidate is meaningful *even when the surrounding suite is red* —
which is the normal state of real repositories. AV-2 is therefore the floor for any
contract that gates settlement, not a premium tier.

## Structure

### `subject` — acquisition and materialization are separate

Phase 1 found the architecture conflated these. Fetching source needs network and
happens on the host; materializing a runnable offline environment is a different step
with a different failure mode, and a job can succeed at the first and fail the second.

```yaml
subject:
  acquisition:
    repository: github.com/acme/widgets
    base_commit: 4a91c0e8d2f1b3c7a5e9d0f2b4c6a8e1d3f5b7c9
    bundle_sha256: "b7e41c92a6d038f5…"   # 64-hex, the fetched source
  materialization:
    status: FROZEN_DEPENDENCIES   # HERMETIC | FROZEN_DEPENDENCIES | MOCKED_EXTERNAL_SYSTEM
    dependency_cache:
      sha256: "..."
      bytes: 263378946
      populate_command: ["npm", "ci", "--offline"]
    frozen_inputs: []             # REQUIRED and non-empty when status is MOCKED_EXTERNAL_SYSTEM
```

`REQUIRES_NETWORK` and `UNMATERIALIZABLE` are not valid contract states. A job in either
condition cannot be verified by the Witness and must route to another verifier class or
be rejected at preflight.

`MOCKED_EXTERNAL_SYSTEM` requires `frozen_inputs` to be declared and hashed. Without
that, "mocked" is an unfalsifiable claim — the second Phase-1 correction.

### `candidate` — protected paths are load-bearing

```yaml
candidate:
  format: git_patch
  allowed_paths: ["src/**", "test/**"]
  protected_paths:
    - "package.json"          # the file defining the judging command
    - ".github/**"
    - "averray/**"
    - "Dockerfile"
  maximum_changed_files: 20
```

`protected_paths` is what makes "can the candidate modify the command that judges it"
answerable. Preflight reports candidate-modifiability; this field is the policy that
acts on it. A contract whose judging command lives in an unprotected path is invalid.

### `checks` — targeted first, suite optional

```yaml
checks:
  targeted:                     # PRIMARY. At least one required.
    - id: empty-input-regression
      command: ["npm", "test", "--", "--test-name-pattern", "unitless"]
      expected_on_base: fail    # must genuinely fail before the change
      expected_on_candidate: pass
      required: true

  regression:                   # OPTIONAL. Default required: false.
    - id: full-suite
      command: ["npm", "test"]
      expected: pass
      required: false           # true only where the base suite is green
      base_state: red           # recorded at preflight, not assumed

  hidden:
    bundle_sha256: "3f1a…"                # 64-hex
    required: false                       # DEFAULTS false; rule 7 tests this field
    eligibility_reference_sha256: "9c72…" # required only when required: true
```

`expected_on_base: fail` is enforced. If the targeted check already passes on base, the
contract is invalid — there is nothing for the candidate to demonstrate, and a `PASS`
would prove nothing.

`base_state` is recorded from preflight rather than assumed, so a contract cannot
silently require a green suite against a repository whose suite is red.

**Hidden-check eligibility.** A hidden check is an authored artifact and can simply be
wrong, producing a confident false `FAIL` — the most expensive failure mode. A hidden
bundle is only eligible once it has passed against a known-good reference solution,
whose digest is recorded as `eligibility_reference_sha256`. An unvalidated hidden bundle
may be carried but must not be `required`.

### Command provenance — rule 5 fails closed

Rule 5 requires the file defining a judging command to be listed in
`protected_paths`. That presumes the defining file can be *determined*, and for many
commands it cannot. The implementation resolves:

| Resolves | Does not resolve |
|---|---|
| `npm` / `pnpm` / Yarn scripts | `make` targets — may select GNUmakefile, makefile, Makefile, or includes |
| explicit repository scripts | `cargo`, `go`, Ruby, pytest/module runners |
| direct `node` commands | `sh -c` shell strings, `npx`, `bun`, workspace/relocation forms |

**Unresolvable means rejected, not permitted.** A contract whose judging command cannot
be traced to a protectable file is invalid at freeze time. An unprovable protection is
not a protection — the contract would otherwise claim a guarantee it cannot enforce.

This is a real constraint on which repositories can be verified, not a temporary gap.
Extending the resolver widens coverage; it never changes the fail-closed default.

### `integrity` — the anti-gaming surface

```yaml
integrity:
  judging_commands_immutable: true
  forbid:
    - test_deletion
    - skip_or_xfail_markers_added
    - runner_replacement
    - assertion_neutering
    - snapshot_rewrite_to_accept_current
    - coverage_or_lint_exclusion_of_changed_files
    - error_swallowing_to_force_zero_exit
```

Each entry is a detection the Witness must perform and report, not advice. A violation
yields `POLICY_VIOLATION`, which is a distinct verdict from `FAIL` — the candidate did
not merely fail to satisfy the contract, it attacked the mechanism deciding.

### `inconclusive_policy` — attribution, not just tolerance

`INCONCLUSIVE` must not penalise a worker. That is correct and it creates an exploit: a
worker facing `FAIL` is better off inducing an inconclusive result. The contract
therefore requires attribution.

```yaml
inconclusive_policy:
  infrastructure_attributable:   # never counted against the worker, ever
    - host_failure
    - image_unavailable
    - platform_timeout
    - dependency_cache_unavailable
  candidate_attributable:        # no penalty, but a counted signal
    - candidate_introduced_flakiness
    - candidate_exceeded_resource_limit
    - candidate_caused_nondeterminism_across_repetitions
  repeated_candidate_attributable:
    window: 10
    threshold: 3
    action: escalate_to_human    # never automatic slashing
```

Repeated candidate-attributable inconclusives from one worker are evidence in
themselves. The action is escalation, never automatic punishment — a false accusation
here costs more than a missed one.

### `reproducibility`, `resources`, `settlement`

```yaml
reproducibility:
  repetitions: 2
  disagreement_result: INCONCLUSIVE_FLAKY
  random_seed: 48291

resources:
  timeout_seconds: 900
  cpu_limit: 2
  memory_mb: 4096
  process_limit: 256
  writable_storage_mb: 2048
  max_output_bytes: 10485760

settlement:
  minimum_assurance_level: AV-2
  pass_required: true
  human_overlay_required: false
  challenge_window_blocks: 100
```

## Worked instance

Against `depre-dev/averray-send-test` — the one corpus repo that is both `HERMETIC` and
base-green, and therefore the only one where a full-suite requirement is honest:

```yaml
schema_version: averray.verification-contract/v1
job:
  id: "0x7d3f9a2e5c1b8046a3f7e2d9c4b60158e7a3d1"
  type: code_change
  required_verification_level: AV-2
subject:
  acquisition:
    repository: github.com/depre-dev/averray-send-test
    base_commit: "4257106b9e3f2a8d15c74e0b6a93df82c105e7d4"
    bundle_sha256: "b7e41c92a6d038f5142c9e7b30a586df41e2c9037bd85a1f6e04c2793adb85f1"
  materialization:
    status: HERMETIC
    dependency_cache: null
    frozen_inputs: []
candidate:
  format: git_patch
  allowed_paths: ["src/**", "test/**"]
  protected_paths: ["package.json"]
  maximum_changed_files: 5
checks:
  targeted:
    - id: unitless-duration
      command: ["node", "--test", "--test-name-pattern", "unitless"]
      expected_on_base: fail
      expected_on_candidate: pass
      required: true
  regression:
    - id: full-suite
      command: ["npm", "test"]
      expected: pass
      required: true            # honest here: this repo's base suite IS green
      base_state: green
settlement:
  minimum_assurance_level: AV-2
  pass_required: true
```

Note `package.json` is protected: it defines `npm test`, so leaving it writable would
let the candidate rewrite the command judging it.

## Invalid contracts

A contract is rejected at freeze time if any of these hold. These are validation rules,
not guidance:

- `materialization.status` is `REQUIRES_NETWORK` or `UNMATERIALIZABLE`
- `status` is `MOCKED_EXTERNAL_SYSTEM` with empty `frozen_inputs`
- no `targeted` check is `required: true`
- a targeted check declares `expected_on_base: pass`
- a judging command is defined in a file that is not in `protected_paths`
- a `regression` check is `required: true` while its `base_state` is `red`
- a hidden bundle is `required: true` without `eligibility_reference_sha256`
- `settlement.minimum_assurance_level` is below `AV-2` while `pass_required: true`

## Implementation status

Freeze validation is implemented in `witness/src/verification-contract.mjs` and all
eight rejection rules are enforced with named codes (`VCV1_RULE_n_*`). What is **not**
implemented, and is therefore not yet a guarantee:

- **Strict digest validation.** Digest fields are validated as strings, not as 64-hex.
  A malformed digest passes freeze today.
- **Contract execution.** Nothing runs a contract yet; this object is validated, not
  applied.
- **The `integrity` detections.** Every entry in that list is a requirement on the
  Witness, and none is built. A contract may declare them; nothing enforces them yet.

Contracts frozen before those land carry weaker guarantees than they appear to. Do not
cite the `integrity` list as a capability until Phase 2 makes it one.

## Open

- **Digest algorithm over the contract.** Must be canonical and stable across
  serialisation; the platform already has `hashCanonicalContent`, which is the obvious
  candidate but has not been evaluated for this purpose.
- **Contract versioning on dispute.** A replay must execute the contract version the
  original receipt names, not the current one. Storage and lookup are unspecified.
- **Who authors targeted checks.** The verifier-planner proposes; the creator freezes.
  Whether a poster can be *required* to supply a targeted check, or whether the planner
  may author one unaided, is a product decision and is not settled here.
