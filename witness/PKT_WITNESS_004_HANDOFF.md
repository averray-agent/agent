# PKT-WITNESS-004 handoff

## Delivered together

- VerificationContract `averray.verification-contract/v1.1` documentation, strict
  schema, normalizer, static validator, and evidence-producing freeze validator.
- Verified artifact references for source bundles, dependency caches, frozen inputs,
  and supplied hidden tests (`sha256`, `bytes`, `locator`, and `format`).
- Contract-supplied differential tests mounted read-only into baseline and candidate
  workspaces, with an explicit command manifest and working directory.
- Candidate-path policy for supplied tests and other contract artifacts.
- Explicit check working directories, including working-directory-aware npm/pnpm/Yarn
  command provenance.
- Removal of the unenforceable workspace quota. v1.1 exposes only the enforced `/tmp`
  `temporary_storage_mb` limit.
- A 15th full-executor `snapshot_rewrite_to_accept_current` corpus case and a matrix
  qualification naming six known-undetectable, unrepresented classes.

The immutable v1 schema remains checked in and v1 contracts remain loadable. Their
bare artifact digests retain the v1 execution limitations.

## Drill evidence

`npm --prefix witness test`:

- 60 tests passed, including malformed v1.1 additions, freeze evidence, read-only
  baseline/candidate mounts, offline dependency materialization, and supplied-test
  modification policy.

`npm --prefix witness run v1.1:drills`:

| Guard | Anchor occurrences | Mutation applied | Malformed with guard | Corrected | Guard disabled |
|---|---:|---|---|---|---|
| artifact locator path | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| artifact format | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| artifact SHA-256 | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| hidden command manifest | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| working directory | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| temporary storage field | 1 | yes | GREEN / rejected | GREEN / accepted | RED / accepted |
| observed base failure | 1 | yes | GREEN / rejected | n/a | RED / accepted |

The existing eight v1 rule drills and seven integrity mutation drills remain green;
each also confirms exactly one mutation anchor before trusting its expected red.

## Corrected worked instance

`examples/averray-send-test/contract-v1.1.json` uses:

- commit `42571061ca9b6da8c6aca908f1ee1df1dab4e10a`;
- source archive SHA-256
  `c9128c609c312f9a486dacfc13885d1ef171bb9113d2c755770585cd673b9eb8`
  over 1,229 bytes;
- supplied-test SHA-256
  `5559ff78c500b110e9555d4a8214e89b300f3e1b19bf2637fbee4cf1364a20ee`
  over 233 bytes; and
- the known-good patch byte SHA-256
  `73ba7cb28f3379ee4d592296ced500790ca6673d9b00fcc125a60bdb6d120036`.

Observed Docker results:

- freeze baseline: supplied test `fail` (exit 1), contract accepted;
- unchanged full suite: pass;
- correct candidate: supplied test pass and full suite pass in both repetitions;
- final verdict: `PASS`;
- supplied-test replacement patch: `POLICY_VIOLATION` with
  `supplied_test_modified`.

## 15-case corpus

The real executor produced exact verdicts 15/15, zero false passes, zero false fails,
three inconclusives (20%), attribution accuracy 3/3, and a green workspace-isolation
drill. The snapshot rewrite row produced the named
`snapshot_rewrite_to_accept_current` policy violation.

This result is explicitly scoped: it is zero false passes across represented,
detectable classes. The matrix lists six known-undetectable semantic/framework classes
that are not represented. The naive executor has seven false passes and exact verdicts
6/15.

## Rule 5 command coverage

Resolves npm and pnpm scripts, simple Yarn scripts, explicit Node/Python/shell repository
scripts, and direct Node test/eval commands. npm/pnpm exec-style forms, Yarn workspace
and relocation forms, Make, Cargo, Go, Ruby, pytest/module runners, shell command
strings, npx, bun, and unknown families fail closed when their definition cannot be
proved.

## Remaining v1.1 limitations

> PKT-WITNESS-005 supersedes the source-provenance limitation below with an offline
> Git-bundle binding. See `PKT_WITNESS_005_HANDOFF.md` for its tested boundary.

1. ~~The exact source archive is digest-pinned, but a generic tar has no embedded Git
   identity tying its bytes cryptographically to the human-readable `base_commit`.
   The worked HTTPS locator embeds the commit; a future source format should add a
   verifiable commit/tree manifest.~~ Superseded by PKT-WITNESS-005.
2. `eligibility_reference_sha256` is still evidence supplied by the author. v1.1
   proves the supplied test fails on base and the worked drill proves it against a
   known-good patch, but the contract does not carry a locator/format for automatically
   replaying every eligibility reference at freeze.
3. `hidden` means evaluator-supplied and candidate-protected, not confidential. The
   contract does not define encryption or authenticated private-artifact retrieval.
4. Artifact acquisition currently buffers each artifact before verification and safe
   extraction. Large caches need a streaming implementation before production-scale
   limits are raised.
5. The contract digest algorithm remains deliberately open; this PR does not choose
   `hashCanonicalContent` or any replacement.
