import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { materializeContractSource } from "../src/contract-runtime.mjs";
import { executeVerificationContract, VERDICTS } from "../src/executor.mjs";
import {
  assertDeclaredBundleBinding,
  materializeGitBundleSource,
  SourceCommitBindingError
} from "../src/git-bundle-source.mjs";
import { runProcess } from "../src/process.mjs";
import {
  loadVerificationContract,
  validateVerificationContractAtFreeze
} from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_ROOT = resolve(WITNESS_ROOT, "examples", "averray-send-test");
const WORKED_PATH = resolve(EXAMPLE_ROOT, "contract-v1.1.json");
const CORRECT_PATCH = resolve(WITNESS_ROOT, "corpus", "adversarial", "cases", "pass-correct.patch");

function artifactFor(bytes, path) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    locator: { kind: "path", path },
    format: "git-bundle"
  };
}

async function git(args, cwd) {
  const result = await runProcess("git", args, { cwd, timeoutSeconds: 30 });
  assert.equal(
    result.exitCode,
    0,
    result.spawnError || result.stderr || result.stdout || `git ${args.join(" ")} failed`
  );
  return result.stdout.trim();
}

async function createDerivedCommitBundle(root) {
  const contract = await loadVerificationContract(WORKED_PATH);
  const repository = join(root, "real-repository");
  const materialized = await materializeContractSource({
    contract,
    destination: repository,
    cwd: EXAMPLE_ROOT
  });
  await git(["config", "user.name", "Witness binding drill"], repository);
  await git(["config", "user.email", "witness@example.invalid"], repository);
  await writeFile(join(repository, "different-commit.txt"), "this tree is not the declared base\n");
  await git(["add", "different-commit.txt"], repository);
  await git(["commit", "-m", "binding drill: different tree"], repository);
  const differentCommit = await git(["rev-parse", "HEAD"], repository);
  await git(["branch", "artifact-commit", differentCommit], repository);
  const bundlePath = join(root, "different-commit.bundle");
  await git(["bundle", "create", bundlePath, "refs/heads/artifact-commit"], repository);
  const bytes = await readFile(bundlePath);
  return {
    artifact: artifactFor(bytes, "different-commit.bundle"),
    baseCommit: materialized.commit,
    bundlePath,
    bytes,
    differentCommit
  };
}

async function contractUsing(root, gitBundle, baseCommit) {
  const contract = JSON.parse(await readFile(WORKED_PATH, "utf8"));
  contract.subject.acquisition.base_commit = baseCommit;
  contract.subject.acquisition.git_bundle = gitBundle;
  await writeFile(join(root, "unitless.test.mjs"), await readFile(join(EXAMPLE_ROOT, "unitless.test.mjs")));
  return contract;
}

function sandboxResult(exitCode, id = "binding-drill-container") {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    spawnError: null,
    timedOut: false,
    outputTruncated: false,
    seconds: 0.001,
    containerId: id,
    networkMode: "none",
    networkInterfaces: ["lo"],
    networkAssertionPassed: true
  };
}

test("an advertised tag object cannot masquerade as the declared commit", () => {
  const tagObject = "a".repeat(40);
  const peeledCommit = "b".repeat(40);
  assert.throws(
    () => assertDeclaredBundleBinding(
      [{ oid: tagObject, ref: "refs/tags/release" }],
      peeledCommit,
      tagObject
    ),
    SourceCommitBindingError
  );
});

test("a real bundle at a different commit is rejected before any baseline container", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-wrong-commit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createDerivedCommitBundle(root);
  assert.notEqual(fixture.differentCommit, fixture.baseCommit);
  const contract = await contractUsing(root, fixture.artifact, fixture.baseCommit);
  let containersCreated = 0;
  let imageRequests = 0;
  const rejection = await validateVerificationContractAtFreeze(contract, { cwd: root }, {
    temporaryParent: root,
    ensureImage: async () => {
      imageRequests += 1;
      return { image: "unused" };
    },
    runContainer: async () => {
      containersCreated += 1;
      return sandboxResult(1);
    }
  });
  assert.equal(rejection.valid, false);
  assert.equal(rejection.issues[0].code, "VCV11_FREEZE_SOURCE_COMMIT_BINDING");
  assert.equal(rejection.issues[0].attribution, "contract");
  assert.match(rejection.issues[0].message, new RegExp(fixture.baseCommit, "u"));
  assert.equal(imageRequests, 0, "binding must be checked before resolving a sandbox image");
  assert.equal(containersCreated, 0, "binding failure must not create a baseline container");

  const report = await executeVerificationContract({
    contract,
    candidatePatch: CORRECT_PATCH,
    cwd: root
  }, {
    temporaryParent: root,
    ensureImage: async () => ({ image: "unused" }),
    runContainer: async () => {
      containersCreated += 1;
      return sandboxResult(1);
    }
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "contract");
  assert.equal(report.reason, "source_commit_binding_failed");
  assert.equal(report.workerConsequence, "none");
  assert.equal(containersCreated, 0);
});

test("tampered and truncated artifacts are rejected by independent layers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-tampered-bundle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createDerivedCommitBundle(root);

  const tampered = Buffer.from(fixture.bytes);
  const refOffset = tampered.indexOf("refs/heads/artifact-commit");
  assert.notEqual(refOffset, -1, "the tamper anchor must exist in the bundle header");
  tampered[refOffset + "refs/heads/artifact-".length] = "x".charCodeAt(0);
  await writeFile(join(root, "tampered.bundle"), tampered);
  await assert.rejects(
    materializeGitBundleSource({
      artifact: { ...fixture.artifact, locator: { kind: "path", path: "tampered.bundle" } },
      declaredCommit: fixture.differentCommit,
      destination: join(root, "tampered-checkout"),
      baseDirectory: root
    }),
    (error) => error instanceof SourceCommitBindingError && /SHA-256/u.test(error.message)
  );

  const truncated = fixture.bytes.subarray(0, fixture.bytes.length - 32);
  await writeFile(join(root, "truncated.bundle"), truncated);
  await assert.rejects(
    materializeGitBundleSource({
      artifact: artifactFor(truncated, "truncated.bundle"),
      declaredCommit: fixture.differentCommit,
      destination: join(root, "truncated-checkout"),
      baseDirectory: root
    }),
    (error) => error instanceof SourceCommitBindingError &&
      /verification failed|could not be cloned|early EOF/u.test(error.message)
  );
});

test("a baseline expectation mismatch is contract-attributable with no worker consequence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-contract-attribution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const report = await executeVerificationContract({
    contract: await loadVerificationContract(WORKED_PATH),
    candidatePatch: CORRECT_PATCH,
    cwd: EXAMPLE_ROOT
  }, {
    temporaryParent: root,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    runContainer: async (options) => sandboxResult(0, `${options.phase}-${options.checkId}`)
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "contract");
  assert.equal(report.reason, "baseline_mismatch");
  assert.equal(report.workerConsequence, "none");
});

test("Git tree binding covers attributes and symlink entries", {
  skip: process.platform === "win32" ? "symlink checkout semantics require a Unix host" : false
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-git-tree-semantics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  await git(["init"], repository);
  await git(["config", "user.name", "Witness tree drill"], repository);
  await git(["config", "user.email", "witness@example.invalid"], repository);
  await writeFile(join(repository, ".gitattributes"), "*.txt text eol=crlf\n");
  await writeFile(join(repository, "target.txt"), "tree content\n");
  await symlink("target.txt", join(repository, "target-link"));
  await git(["add", "."], repository);
  await git(["commit", "-m", "attributes and symlink tree"], repository);
  const commit = await git(["rev-parse", "HEAD"], repository);
  const tree = await git(["rev-parse", "HEAD^{tree}"], repository);
  await git(["branch", "artifact-commit", commit], repository);
  const bundlePath = join(root, "semantics.bundle");
  await git(["bundle", "create", bundlePath, "refs/heads/artifact-commit"], repository);
  const bytes = await readFile(bundlePath);
  const materialized = await materializeGitBundleSource({
    artifact: artifactFor(bytes, "semantics.bundle"),
    declaredCommit: commit,
    destination: join(root, "checkout"),
    baseDirectory: root
  });
  assert.equal(materialized.tree, tree);
  assert.equal(materialized.bindingVerified, true);
  assert.equal((await lstat(join(materialized.path, "target-link"))).isSymbolicLink(), true);
});
