import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const backend = join(root, "mcp-server");
const reporterPath = "scripts/ops/backend-test-discovery-reporter.mjs";
const packageJson = JSON.parse(await readFile(join(backend, "package.json"), "utf8"));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const unitScript = packageJson.scripts["test:unit"];
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUN_HTTP_SMOKE: "" };
// These are independent CLI runs, not children of this test runner's IPC harness.
delete env.NODE_TEST_CONTEXT;

async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(path));
    else if (entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const run = (script, cwd) => exec("/bin/sh", ["-c", script], { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });

async function fixture(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "backend-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts/ops"), { recursive: true });
  await writeFile(join(dir, reporterPath), await readFile(join(root, reporterPath)));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), source);
  }
  return dir;
}

const passingTest = 'const { test } = require("node:test"); test("discovered fixture", () => {});';

test("configured backend unit runner executes every repository test file", { timeout: 120_000 }, async () => {
  const count = (await inventory(join(backend, "src"))).length;
  const { stdout } = await run(unitScript, backend).catch((error) => {
    const lines = String(error.stdout ?? "").split("\n");
    const failures = lines.flatMap((line, i) => /^\s*not ok\b/.test(line) ? lines.slice(i, i + 35) : []);
    error.message += "\nNested backend failures:\n" + failures.join("\n");
    throw error;
  });
  const line = `# backend-test-discovery expected=${count} executed=${count} missing=0`;
  assert.ok(stdout.includes(line), "the configured runner must report its actual file count");
  // Make the numeric evidence visible in the CI log, not just an assertion.
  console.log(line);
});

test("recursive runner needs no profile-routes append workaround", () => {
  assert.doesNotMatch(unitScript, /src\/protocols\/http\/profile-routes\.test\.js/u);
});

test("historical packet census is 184 POSIX glob files versus 241 recursive files", async () => {
  const { stdout } = await exec("git", ["ls-tree", "-r", "--name-only", "6cb88d4495d813a85d7ade5c157c2da2b1af6964", "mcp-server/src"], { cwd: root });
  const files = stdout.trim().split("\n").filter((path) => path.endsWith(".test.js"));
  const shallow = files.filter((path) => path.split("/").length === 4);
  assert.equal(shallow.length, 184);
  assert.equal(files.length, 241);
  console.log("# historical backend census at 6cb88d44: 184 -> 241; current counts are audited separately");
});

test("configured recursive backend discovery executes depth-three fixtures and rejects the POSIX glob mutation", async (t) => {
  const dir = await fixture(t, {
    "mcp-server/src/core/shallow.test.js": passingTest,
    "mcp-server/src/nested/deeper/deep.test.js": passingTest,
    "mcp-server/src/protocols/http/profile-routes.test.js": passingTest
  });
  const cwd = join(dir, "mcp-server");
  const { stdout } = await run(unitScript, cwd);
  assert.match(stdout, /backend-test-discovery expected=3 executed=3 missing=0/u);
  const mutation = unitScript.replace("'src/**/*.test.js'", "src/**/*.test.js");
  assert.notEqual(mutation, unitScript, "the unquoting mutation must actually apply");
  await assert.rejects(run(mutation, cwd), (error) => (
    error.code !== 0 && `${error.stdout}\n${error.stderr}`.includes("Backend test files were not all executed")
  ));
});

test("configured example test discovery executes nested fixtures", async (t) => {
  const dir = await fixture(t, {
    "examples/shallow/one.test.mjs": 'import test from "node:test"; test("shallow example", () => {});',
    "examples/nested/deeper/two.test.mjs": 'import test from "node:test"; test("deep example", () => {});'
  });
  const { stdout } = await run(rootPackage.scripts["test:examples"], dir);
  assert.match(stdout, /deep example/u);
  assert.match(stdout, /# tests 2\b/u);
});

test("unit discovery skips HTTP smoke while its explicit phase sets RUN_HTTP_SMOKE=1", async (t) => {
  assert.equal(packageJson.scripts.test, "npm run test:unit && npm run test:http-smoke");
  const smoke = await readFile(join(backend, "src/protocols/http/server.smoke.test.js"), "utf8");
  assert.match(smoke, /const RUN = process\.env\.RUN_HTTP_SMOKE === "1";/u);
  assert.match(smoke, /skip: !RUN/u);
  const dir = await fixture(t, {
    "mcp-server/src/protocols/http/profile-routes.test.js": passingTest,
    "mcp-server/src/protocols/http/server.smoke.test.js": 'const { test } = require("node:test"); test("smoke-phase fixture", { skip: process.env.RUN_HTTP_SMOKE !== "1" }, () => {});'
  });
  const unit = await run(unitScript, join(dir, "mcp-server"));
  assert.match(unit.stdout, /# skipped 1\b/u);
  const explicit = await run(packageJson.scripts["test:http-smoke"], join(dir, "mcp-server"));
  assert.match(explicit.stdout, /# pass 1\b/u);
  assert.match(explicit.stdout, /# skipped 0\b/u);
});
