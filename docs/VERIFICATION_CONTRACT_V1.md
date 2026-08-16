# VerificationContract v1.1

Status: **draft.** v1.1 supersedes the v1 draft without changing already-frozen v1
objects. The Witness loader continues to accept both discriminators; new contracts use
`averray.verification-contract/v1.1` and the checked-in
`witness/schema/verification-contract-v1.1.schema.json`.

The contract is frozen before a job becomes claimable. It defines the exact source,
inputs, commands, sandbox limits, and acceptance differential that the Witness can
prove. Contract digesting, receipts, signing, replay, storage, reputation, settlement
execution, `worker/`, and the money rail remain out of scope.

## Why v1.1 exists

Phase 2 executed the v1 worked example and found that its targeted command exited zero
on the unchanged base. The pinned repository contains no test for the unitless-duration
bug, so `--test-name-pattern unitless` selects nothing and Node reports success. This is
not an unusual edge case: bugs commonly survive because no existing test catches them.

A useful bug-fix contract therefore cannot be limited to tests already in the source
repository. v1.1 makes a contract-supplied differential check first class through
`checks.hidden`:

- its bytes, length, locator, and format are frozen;
- the Witness verifies the bytes before execution;
- it is mounted read-only at the same path in every baseline and candidate workspace;
- its command and working directory are part of the contract;
- it must fail on base and is expected to pass on the candidate;
- a patch touching its mount path is a named `POLICY_VIOLATION`; and
- freeze validation executes it on the base. `expected_on_base: fail` is a claim until
  that observation exists.

The v1 worked commit was also invented valid-shaped hex. The real, verified revision is
`42571061ca9b6da8c6aca908f1ee1df1dab4e10a`.

Phase 2 also exposed a provenance hole in the first v1.1 draft: the source archive's
SHA-256 fixed its bytes, but nothing proved those bytes were the tree named by
`base_commit`. v1.1 now requires a full Git bundle. Before any sandbox is selected or
container is created, the Witness verifies the bundle offline, requires exactly one
advertised ref at `base_commit`, clones it under isolated Git configuration, runs a
full strict object check, and checks out that commit. A byte digest is still used for
artifact transport integrity; Git's commit and tree object IDs establish provenance.

## Artifact references

Caches, frozen inputs, and supplied checks use this artifact shape:

```yaml
sha256: c9128c609c312f9a486dacfc13885d1ef171bb9113d2c755770585cd673b9eb8
bytes: 1229
locator:
  kind: https                    # https | path
  url: https://example.test/source.tar.gz
format: tar+gzip                 # file | tar | tar+gzip
```

A `path` locator is relative to the contract file and may not be absolute or traverse
upward. An `https` locator must be an absolute HTTPS URL. The Witness fetches the bytes,
then verifies both `bytes` and the lowercase 64-hex SHA-256 before using them. Redirects
do not relax the HTTPS requirement.

`file`, `tar`, and `tar+gzip` are the generic artifact formats the executor implements.
Archive extraction accepts regular files, directories, and global PAX metadata. Links,
devices, per-entry PAX path overrides, absolute paths, and upward traversal are
rejected.

Source acquisition is deliberately narrower. `subject.acquisition.git_bundle` has the
same digest, length, and locator fields but its format is exactly `git-bundle`. A full
bundle must have no missing prerequisites and exactly one advertised ref whose object
ID equals `base_commit`. Reachable commit history may be present; extra advertised refs
are rejected. Generic source tarballs are no longer valid v1.1 source artifacts.

Artifact references replace every v1 bare digest:

```yaml
subject:
  acquisition:
    repository: github.com/acme/widgets
    base_commit: 4a91c0e8d2f1b3c7a5e9d0f2b4c6a8e1d3f5b7c9
    git_bundle:
      sha256: "..."
      bytes: 1234
      locator: { kind: https, url: "https://example.test/source.bundle" }
      format: git-bundle
  materialization:
    status: FROZEN_DEPENDENCIES
    dependency_cache:
      artifact:
        sha256: "..."
        bytes: 263378946
        locator: { kind: https, url: "https://example.test/npm-cache.tar" }
        format: tar
      mount_path: .averray/dependency-cache
      populate_command: ["npm", "ci", "--offline", "--cache", ".averray/dependency-cache"]
      working_directory: .
    frozen_inputs:
      - path: fixtures/api.json
        artifact:
          sha256: "..."
          bytes: 719
          locator: { kind: path, path: "artifacts/api.json" }
          format: file
```

The dependency cache and frozen inputs are mounted read-only into every clean attempt.
The dependency `populate_command` executes offline before checks. `REQUIRES_NETWORK`
and `UNMATERIALIZABLE` remain invalid contract states.

## Checks and working directories

Every command has an explicit repository-relative `working_directory`; `.` means the
repository root. This removes the v1 monorepo ambiguity and makes command provenance
relative to the directory that actually runs it.

```yaml
checks:
  targeted: []
  regression:
    - id: package-suite
      command: ["npm", "test"]
      working_directory: packages/widget
      expected: pass
      required: true
      base_state: green
  hidden:
    id: supplied-unitless-duration
    artifact:
      sha256: "5559ff78c500b110e9555d4a8214e89b300f3e1b19bf2637fbee4cf1364a20ee"
      bytes: 233
      locator: { kind: path, path: "unitless.test.mjs" }
      format: file
    mount_path: .averray/supplied-tests/unitless.test.mjs
    command: ["node", "--test", ".averray/supplied-tests/unitless.test.mjs"]
    working_directory: .
    expected_on_base: fail
    expected_on_candidate: pass
    required: true
    eligibility_reference_sha256: "73ba7cb28f3379ee4d592296ced500790ca6673d9b00fcc125a60bdb6d120036"
```

The hidden command manifest must name its mount path or a descendant. A required hidden
check still needs a known-good eligibility reference. In the worked instance that
reference is the SHA-256 of the exact known-good patch bytes; it is evidence that the
supplied check passes against a solution, while freeze evidence separately proves the
check fails on base.

At least one required differential is mandatory. It can be an ordinary `targeted`
check or the contract-supplied `hidden` check. Regressions do not satisfy this rule.

## Candidate protection and command provenance

`candidate.protected_paths` remains load-bearing. Package commands resolve relative to
their working directory: `npm test` in `packages/widget` is defined by
`packages/widget/package.json`, not the root manifest.

The resolver proves these families:

| Resolves | Fails closed |
|---|---|
| npm, pnpm, and simple Yarn scripts | npm/pnpm exec, x, dlx and Yarn workspace/relocation forms |
| explicit Node, Python, and shell script paths | Cargo, Go, Ruby, pytest/module runners without an explicit script path |
| direct Node `--test` and eval commands | Make targets, shell command strings, npx, bun, and unknown command families |

When the defining file cannot be proven, the contract is rejected. A direct command
has no repository definition file, but any contract-supplied test file it executes is
separately protected by the read-only nested mount and candidate-path policy.

## Resources

```yaml
resources:
  timeout_seconds: 900
  cpu_limit: 2
  memory_mb: 4096
  process_limit: 256
  temporary_storage_mb: 2048
  max_output_bytes: 10485760
```

v1's `writable_storage_mb` is removed. The executor uses a read-write host bind mount
for the candidate workspace, and Docker cannot apply that quota to the bind mount.
v1.1 declares only `temporary_storage_mb`, which is enforced on the container's `/tmp`
tmpfs. The workspace has no contract-level storage quota; host capacity is operational
infrastructure, not a contract guarantee.

## The eight freeze rejection rules

A contract is rejected with the named rule when:

1. `materialization.status` is `REQUIRES_NETWORK` or `UNMATERIALIZABLE`.
2. `MOCKED_EXTERNAL_SYSTEM` has no `frozen_inputs`.
3. neither `checks.targeted` nor the contract-supplied hidden check has a required
   differential.
4. a targeted or supplied check declares base pass, or the Witness executes it at
   freeze and observes base pass.
5. a judging command definition cannot be resolved or its defining file is not in
   `protected_paths`.
6. a required regression declares `base_state: red`.
7. a required hidden check lacks `eligibility_reference_sha256`.
8. `settlement.pass_required` is true below `AV-2`.

Static validation is necessary but not freeze-complete. Call
`validateVerificationContractAtFreeze` (or `witness/bin/freeze-contract.mjs`) to acquire
the pinned artifacts, establish Git provenance, and obtain the base-failure evidence
required by rule 4. A binding failure is a contract rejection and occurs before image
resolution or baseline container creation.

## Inconclusive attribution

`contract` is a third `INCONCLUSIVE` attribution alongside `infrastructure` and
`candidate`. Source/commit binding failures, baseline expectation mismatches, and other
contract-declared preconditions found untrue route to `contract`. Host, image, and
transport failures remain infrastructure-attributable; candidate time/resource and
nondeterminism failures remain candidate-attributable. Every inconclusive result
records `workerConsequence: none`, including contract-attributable failures.

The optional policy manifest names the three buckets independently:

```yaml
inconclusive_policy:
  infrastructure_attributable: [host_failure, image_unavailable, artifact_unavailable]
  contract_attributable: [source_commit_binding_failed, baseline_mismatch, contract_precondition_untrue]
  candidate_attributable: [candidate_exceeded_resource_limit]
  repeated_candidate_attributable:
    window: 10
    threshold: 3
    action: escalate_to_human
```

## Corrected worked instance

The complete executable instance is checked in at
`witness/examples/averray-send-test/contract-v1.1.json`; its supplied test is adjacent.
The material facts are:

```yaml
schema_version: averray.verification-contract/v1.1
subject:
  acquisition:
    repository: github.com/depre-dev/averray-send-test
    base_commit: "42571061ca9b6da8c6aca908f1ee1df1dab4e10a"
    git_bundle:
      sha256: "66b7cbfb41adebaed4709dab65f4dc9ac45134a962adcb99fc6c2ea2ee62708a"
      bytes: 2863
      locator:
        kind: path
        path: source.bundle
      format: git-bundle
checks:
  targeted: []
  hidden:
    id: supplied-unitless-duration
    artifact:
      sha256: "5559ff78c500b110e9555d4a8214e89b300f3e1b19bf2637fbee4cf1364a20ee"
      bytes: 233
      locator: { kind: path, path: "unitless.test.mjs" }
      format: file
    mount_path: .averray/supplied-tests/unitless.test.mjs
    command: ["node", "--test", ".averray/supplied-tests/unitless.test.mjs"]
    working_directory: .
    expected_on_base: fail
    expected_on_candidate: pass
    required: true
```

The bundle advertises only the declared commit and checks out tree
`2af1b724638102808ed25948d24ebe8649a84bb8`. Observed against that tree: the supplied
test exits 1 on base; the unchanged
suite exits 0. Against the known-good patch, the supplied test and full suite exit 0 in
both candidate repetitions and the contract verdict is `PASS`.

## Confusion-matrix qualification

The adversarial corpus now includes 15 cases, including the previously unit-only
`snapshot_rewrite_to_accept_current` detector. Its matrix carries
`knownUndetectableNotRepresented` explicitly. There are six such semantic/framework
classes. Therefore the supported claim is **zero false passes across represented,
detectable classes**, not an unqualified zero-false-pass claim.

## Still open

- The digest algorithm over the contract object itself remains open. v1.1 does not
  select `hashCanonicalContent` or any alternative.
- A Git bundle binds the superproject object graph but cannot carry the contents of
  separate submodule repositories. v1.1 rejects Git trees containing gitlinks until the
  schema can bind an offline bundle for each submodule.
- Git commit/tree binding includes blob contents, executable modes, symlink entries,
  and the `.gitattributes` file itself. Checkout still applies Git's working-tree
  attribute semantics. Global and system Git configuration are isolated, so custom
  clean/smudge drivers and Git LFS content are not imported from the host or transported
  by the bundle. Such repositories retain correct object identity but may materialize
  pointer/unfiltered working-tree content and fail freeze-time preconditions.
- Static integrity detection remains scoped. Six known semantic or framework-specific
  attack classes are deliberately outside the current corpus and are reported as such.
