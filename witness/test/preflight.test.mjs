import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dependencyPlan, detectToolchain, inferCheckDefinition } from "../src/detect.mjs";
import { resolveRepositorySource } from "../src/materialize.mjs";
import { interpretExecution } from "../src/observe.mjs";
import { runPreflight } from "../src/preflight.mjs";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function result({ exitCode = 0, stdout = "", stderr = "", networkMode = "none" } = {}) {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    spawnError: null,
    timedOut: false,
    outputTruncated: false,
    seconds: 0.01,
    networkMode,
    networkInterfaces: networkMode === "none" ? ["lo"] : ["eth0", "lo"],
    networkAssertionPassed: networkMode === "none"
  };
}

function dependencies(sequence) {
  let index = 0;
  return {
    ensureImage: async (image) => ({ image, built: false, seconds: 0 }),
    runContainer: async () => sequence[index++],
    temporaryParent: tmpdir()
  };
}

test("detects Node and records why", async () => {
  const toolchain = await detectToolchain(resolve(FIXTURES, "looks-hermetic"), "npm test");
  assert.equal(toolchain.kind, "node");
  assert.equal(toolchain.packageManager, "npm");
  assert.ok(toolchain.detectedBy.includes("package.json"));
});

test("repository source resolution rejects executable and local-file URL transports", async () => {
  await assert.rejects(() => resolveRepositorySource("ext::sh -c id"), /not allowed|allowed Git URL/iu);
  await assert.rejects(() => resolveRepositorySource("file:///etc"), /protocol is not allowed/iu);
  assert.deepEqual(
    await resolveRepositorySource("owner/repository"),
    { source: "https://github.com/owner/repository.git", sourceType: "github" }
  );
  assert.deepEqual(
    await resolveRepositorySource("github.com/depre-dev/averray-send-test"),
    { source: "https://github.com/depre-dev/averray-send-test.git", sourceType: "github" }
  );
});

test("Python wheelhouse preparation requires exact hash-pinned requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "witness-python-plan-"));
  const pinned = join(root, "pinned");
  const unpinned = join(root, "unpinned");
  await mkdir(pinned);
  await mkdir(unpinned);
  await writeFile(
    join(pinned, "requirements.txt"),
    `pytest==8.3.5 --hash=sha256:${"a".repeat(64)}\n`
  );
  await writeFile(join(unpinned, "requirements.txt"), "pytest>=8\n");
  try {
    const toolchain = { kind: "python", detail: "python" };
    const pinnedPlan = await dependencyPlan(pinned, toolchain);
    const unpinnedPlan = await dependencyPlan(unpinned, toolchain);
    assert.equal(pinnedPlan.supported, true);
    assert.match(pinnedPlan.populateCommand, /--require-hashes/u);
    assert.equal(unpinnedPlan.supported, false);
    assert.match(unpinnedPlan.reason, /hash-pinned/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uv lockfiles use proactive frozen cache preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "witness-uv-plan-"));
  await writeFile(join(root, "pyproject.toml"), '[build-system]\nrequires=["uv_build==0.9.27"]\nbuild-backend="uv_build"\n\n[project]\nname="fixture"\nversion="0.0.1"\n');
  await writeFile(join(root, "uv.lock"), "version = 1\nrevision = 3\nrequires-python = \">=3.11\"\n");
  try {
    const plan = await dependencyPlan(root, { kind: "python", detail: "python" });
    assert.equal(plan.supported, true);
    assert.equal(plan.proactive, true);
    assert.equal(plan.kind, "uv-cache");
    assert.match(plan.populateCommand, /uv sync --locked --no-install-local --no-build/u);
    assert.match(plan.populateCommand, /UV_PYTHON_DOWNLOADS=never/u);
    assert.match(plan.offlineInstallCommand, /UV_OFFLINE=1/u);
    assert.doesNotMatch(plan.offlineInstallCommand, /--no-build(?:\s|$)/u);
    assert.match(plan.offlineInstallCommand, /--no-build-isolation/u);
    assert.match(plan.offlineInstallCommand, /--no-index/u);
    assert.match(plan.offlineInstallCommand, /--require-hashes/u);
    assert.equal(plan.evidence.buildBackend, "pyproject-proven and image-pinned uv-build==0.9.27");
    assert.equal(plan.checkEnvironment.UV_PYTHON_DOWNLOADS, "never");
    assert.equal(plan.checkEnvironment.UV_NO_SYNC, "1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uv preparation fails closed for an unproven build backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "witness-uv-backend-"));
  await writeFile(join(root, "pyproject.toml"), '[build-system]\nrequires=["uv_build==0.9.28"]\nbuild-backend="uv_build"\n');
  await writeFile(join(root, "uv.lock"), "version = 1\nrevision = 3\nrequires-python = \">=3.11\"\n");
  try {
    const plan = await dependencyPlan(root, { kind: "python", detail: "python" });
    assert.equal(plan.supported, false);
    assert.match(plan.reason, /exactly proven uv_build==0\.9\.27/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uv preparation runs before the first Python check and the check stays offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "witness-uv-preflight-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "pyproject.toml"), '[build-system]\nrequires=["uv_build==0.9.27"]\nbuild-backend="uv_build"\n\n[project]\nname="fixture"\nversion="0.0.1"\n');
  await writeFile(join(repository, "uv.lock"), "version = 1\nrevision = 3\nrequires-python = \">=3.11\"\n");
  await writeFile(join(repository, "Makefile"), "gate:\n\tuv run python3 -c 'print(1)'\n");
  const attempts = [];
  const sequence = [
    result({ exitCode: 0, networkMode: "bridge" }),
    result({ exitCode: 0 }),
    result({ exitCode: 0 })
  ];
  try {
    const report = await runPreflight({
      repo: repository,
      check: "make gate",
      copyCheckWorkspaceToTmpfs: true
    }, {
      ensureImage: async (image) => ({ image, built: false, seconds: 0 }),
      runContainer: async (options) => {
        attempts.push(options);
        return sequence[attempts.length - 1];
      },
      temporaryParent: root
    });
    assert.equal(report.classification, "FROZEN_DEPENDENCIES");
    assert.deepEqual(report.attempts.map((attempt) => attempt.phase), [
      "cache-population",
      "offline-dependency-install",
      "prepared-check"
    ]);
    assert.equal(attempts[0].networkMode, "bridge");
    assert.equal(attempts[1].networkMode, "none");
    assert.equal(attempts[2].networkMode, "none");
    assert.equal(attempts[2].copyWorkspaceToTmpfs, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports package-script candidate modifiability from the definition file", async () => {
  const root = resolve(FIXTURES, "looks-hermetic");
  const open = await inferCheckDefinition(root, "npm test", []);
  const protectedDefinition = await inferCheckDefinition(root, "npm test", ["package.json"]);
  assert.equal(open.definitionFile, "package.json");
  assert.equal(open.candidateModifiable, true);
  assert.equal(protectedDefinition.candidateModifiable, false);
});

test("a base test failure is HERMETIC when the command genuinely ran offline", async () => {
  const report = await runPreflight({
    repo: resolve(FIXTURES, "network-none"),
    check: "npm test"
  }, dependencies([result({ exitCode: 1, stderr: "AssertionError: expected true" })]));
  assert.equal(report.classification, "HERMETIC");
  assert.equal(report.baseExitStatus, 1);
  assert.equal(report.basePassed, false);
  assert.equal(report.checkCommandExists, true);
});

test("observed offline fetch failure is REQUIRES_NETWORK", async () => {
  let calls = 0;
  const report = await runPreflight({
    repo: resolve(FIXTURES, "network-required"),
    check: "npm test"
  }, {
    ...dependencies([result({ exitCode: 1, stderr: "TypeError: fetch failed ENETUNREACH" })]),
    runContainer: async () => {
      calls += 1;
      return result({ exitCode: 1, stderr: "TypeError: fetch failed ENETUNREACH" });
    }
  });
  assert.equal(report.classification, "REQUIRES_NETWORK");
  assert.match(report.observedFailureReason, /fetch failed/iu);
  assert.equal(calls, 1);
  assert.deepEqual(report.attempts.map((attempt) => attempt.phase), ["unprepared-check"]);
});

test("an explicitly hashed frozen input plus an offline run is MOCKED_EXTERNAL_SYSTEM", async () => {
  const report = await runPreflight({
    repo: resolve(FIXTURES, "network-none"),
    check: "npm test",
    frozenInputs: ["check.mjs"]
  }, dependencies([result({ exitCode: 0 })]));
  assert.equal(report.classification, "MOCKED_EXTERNAL_SYSTEM");
  assert.match(report.frozenInputs[0].sha256, /^[a-f0-9]{64}$/u);
});

test("a lockfile-backed cache that makes the offline check runnable is FROZEN_DEPENDENCIES", async () => {
  const report = await runPreflight({
    repo: resolve(FIXTURES, "looks-hermetic"),
    check: "npm test"
  }, dependencies([
    result({ exitCode: 127, stderr: "sh: 1: tap: not found" }),
    result({ exitCode: 0, networkMode: "bridge" }),
    result({ exitCode: 0 }),
    result({ exitCode: 1, stderr: "1 test failed" })
  ]));
  assert.equal(report.classification, "FROZEN_DEPENDENCIES");
  assert.equal(report.dependencyPreparation.attempted, true);
  assert.equal(report.baseExitStatus, 1);
});

test("a monorepo check keeps root dependency preparation and nested rule-5 working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "witness-monorepo-preflight-"));
  const repository = join(root, "repository");
  const cacheDirectory = join(root, "shared-cache");
  await mkdir(join(repository, "mcp-server"), { recursive: true });
  await writeFile(join(repository, "package.json"), '{"private":true,"workspaces":["mcp-server"]}\n');
  await writeFile(join(repository, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await writeFile(
    join(repository, "mcp-server", "package.json"),
    '{"name":"mcp-server","scripts":{"test":"node --test"}}\n'
  );
  const attempts = [];
  const sequence = [
    result({ exitCode: 127, stderr: "sh: 1: tap: not found" }),
    result({ exitCode: 0, networkMode: "bridge" }),
    result({ exitCode: 0 }),
    result({ exitCode: 0 })
  ];
  try {
    const report = await runPreflight({
      repo: repository,
      check: "npm test",
      workingDirectory: "mcp-server",
      protectedPaths: ["mcp-server/package.json"]
    }, {
      ensureImage: async (image) => ({ image, built: false, seconds: 0 }),
      runContainer: async (options) => {
        attempts.push(options);
        return sequence[attempts.length - 1];
      },
      cacheDirectory,
      temporaryParent: root
    });
    assert.equal(report.classification, "FROZEN_DEPENDENCIES");
    assert.equal(report.check.definitionFile, "mcp-server/package.json");
    assert.equal(report.check.candidateModifiable, false);
    assert.equal(attempts[0].workingDirectory, "mcp-server");
    assert.equal(attempts[1].workingDirectory, undefined);
    assert.equal(attempts[3].workingDirectory, "mcp-server");
    assert.equal(attempts[3].cache, cacheDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing root executable becomes typed UNMATERIALIZABLE", async () => {
  const report = await runPreflight({
    repo: resolve(FIXTURES, "missing-toolchain"),
    check: "ruby test.rb"
  }, dependencies([result({ exitCode: 127, stderr: "/bin/sh: 1: ruby: not found" })]));
  assert.equal(report.classification, "UNMATERIALIZABLE");
  assert.equal(report.checkCommandExists, false);
  assert.match(report.observedFailureReason, /absent/iu);
});

test("execution interpretation distinguishes a missing dependency from a missing command", () => {
  const definition = { declared: true };
  const dependency = interpretExecution(
    result({ exitCode: 127, stderr: "sh: 1: mocha: not found" }),
    { command: "npm test", definition }
  );
  const command = interpretExecution(
    result({ exitCode: 127, stderr: "/bin/sh: 1: cargo: not found" }),
    { command: "cargo test", definition: { declared: null } }
  );
  assert.equal(dependency.dependencyFailure, true);
  assert.equal(dependency.commandAbsent, false);
  assert.equal(command.commandAbsent, true);
});

test("a pytest minversion refusal is dependency preparation, not a hermetic test failure", () => {
  const observation = interpretExecution(
    result({
      exitCode: 4,
      stderr: "ERROR: tox.ini: 'minversion' requires pytest-8.0, actual pytest-7.2.1"
    }),
    { command: "python3 -m pytest", definition: { declared: null } }
  );
  assert.equal(observation.dependencyFailure, true);
  assert.equal(observation.commandAbsent, false);
});
