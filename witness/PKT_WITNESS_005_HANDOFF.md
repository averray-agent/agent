# PKT-WITNESS-005 handoff

## Delivered

- Replaced v1.1's generic source archive with
  `subject.acquisition.git_bundle`, whose format is exactly `git-bundle`.
- Added a checked-in full Git bundle for the worked
  `depre-dev/averray-send-test` commit
  `42571061ca9b6da8c6aca908f1ee1df1dab4e10a`.
- Source materialization now verifies SHA-256 and byte length, verifies the bundle
  offline in an empty repository, requires one advertised ref at the declared commit,
  clones and checks out that object with host Git configuration isolated, runs strict
  `git fsck`, rejects unreachable extra objects and submodule gitlinks, and records the
  checked-out Git tree ID.
- Freeze validation rejects source-binding failures before image resolution or any
  baseline container creation.
- Added `contract` as a third `INCONCLUSIVE` attribution. Source binding failure,
  baseline expectation mismatch, and false contract preconditions route there.
  `workerConsequence` remains explicitly `none` for every inconclusive result.
- Kept contract digesting, receipts, signing, replay, reputation, settlement execution,
  `worker/`, and the money rail out of scope.

## Schema change

The draft v1.1 acquisition object changed from:

```json
{ "repository": "...", "base_commit": "...", "bundle": { "format": "tar+gzip" } }
```

to:

```json
{ "repository": "...", "base_commit": "...", "git_bundle": { "format": "git-bundle" } }
```

Generic `file`, `tar`, and `tar+gzip` artifacts remain valid for caches, frozen inputs,
and supplied checks, but not for source. When `inconclusive_policy` is present in a
v1.1 contract it now also requires `contract_attributable`.

The worked bundle is 2,863 bytes, has SHA-256
`66b7cbfb41adebaed4709dab65f4dc9ac45134a962adcb99fc6c2ea2ee62708a`,
advertises only the declared commit, and resolves to Git tree
`2af1b724638102808ed25948d24ebe8649a84bb8`.

## Drill outputs

`npm --prefix witness run binding:drills`:

| Drill | Guarded | Corrected | Disabled guard (SEEN RED) | Mutation proof |
|---|---|---|---|---|
| Different commit artifact | REJECTED / GREEN | ACCEPTED / GREEN | ACCEPTED / RED | occurrences 1, applied true |
| Reject before baseline | 0 containers / GREEN | — | 1 container / RED | occurrences 1, applied true |
| Tampered bundle header | REJECTED / GREEN | ACCEPTED / GREEN | ACCEPTED / RED | occurrences 1, applied true |
| Truncated bundle, recomputed SHA | REJECTED / GREEN | ACCEPTED / GREEN | ACCEPTED / RED | occurrences 1, applied true |
| Baseline mismatch attribution | contract / GREEN | — | infrastructure / RED | occurrences 1, applied true |
| No worker consequence | none / GREEN | — | null / RED | occurrences 1, applied true |

The different-commit drill starts with the real worked repository at the pinned commit,
creates a second commit with a different tree, bundles that second commit, and declares
the original. Disabling only the advertised/checked-out/declaration comparison accepts
it, so the drill fails under the digest-only provenance model.

The tamper drill changes only the advertised ref name while retaining a valid Git pack;
disabling the byte-digest comparison makes it go red. The truncation drill recomputes
the artifact digest after removing pack bytes; disabling Git object-graph verification
makes it go red.

## Verification

- `npm --prefix witness test`: 66/66 passed.
- `npm --prefix witness run v1.1:drills`: all eight mutation anchors occurred once,
  applied, and produced the expected guarded-green / disabled-red results.
- `npm --prefix witness run binding:drills`: all six drills passed with
  `anchorOccurrences: 1` and `applied: true`.
- Real Docker freeze of the worked contract: `valid: true`; supplied check observed
  `fail` on base; `bindingVerified: true`; commit and tree matched.
- Real Docker execution against `pass-correct.patch`: `PASS`; both baseline repetitions
  observed supplied-test fail and regression pass; both candidate repetitions observed
  supplied-test pass and regression pass.
- `npm --prefix witness run adversarial:corpus`: real executor matched 15/15 cases,
  with 0 false passes, 0 false fails, and 3/3 correct inconclusive attributions across
  the represented detectable classes; workspace isolation remained GREEN.

## `.gitattributes`, symlinks, and the boundary

The binding holds for Git's committed object graph. Tree objects bind file names,
executable modes, blob IDs, symlink entries (mode `120000` and the target text), and the
committed `.gitattributes` file. A drill commits both `.gitattributes` and a symlink,
materializes the bundle, confirms the exact tree ID, and confirms the checkout remains
a symlink on the Unix host.

Checkout can still transform working-tree bytes according to committed attributes.
The Witness disables system/global Git configuration and fixes `core.autocrlf=false`,
so host-specific filter configuration is not inherited. Custom clean/smudge drivers and
Git LFS payloads are not carried by a Git bundle; the committed pointer/blob remains
correctly bound, but external payload content is not materialized and freeze-time
checks may reject the contract. Repositories with submodule gitlinks are rejected
explicitly because one superproject bundle cannot bind the separate repositories.

One remaining schema limitation is that `base_commit` is fixed to 40 lowercase hex
characters, so Git repositories using the SHA-256 object format are not expressible in
v1.1. Symlink checkout is verified on the supported Unix/Docker host path; Windows
checkout semantics are not claimed.
