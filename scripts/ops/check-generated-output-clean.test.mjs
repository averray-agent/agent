import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildProductionDiscoveryManifestContent } from "./discovery-manifest-file.mjs";

const SCRIPT = resolve("scripts/ops/check-generated-output-clean.mjs");

test("generated output guard rejects staged frontend changes", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "frontend/index.html"), "changed\n");
  git(repo, ["add", "frontend/index.html"]);

  const result = runGuard(repo, ["--staged"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontend\/index\.html/);
  assert.match(result.stderr, /ALLOW_GENERATED_EDIT=1/);
});

test("generated output guard allows staged source changes", () => {
  const repo = createRepo();
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app/page.tsx"), "export default function Page() { return null; }\n");
  git(repo, ["add", "app/page.tsx"]);

  const result = runGuard(repo, ["--staged"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ok/);
});

test("generated output guard allows the committed discovery mirror only when generator-identical", () => {
  const repo = createRepo();
  const manifestPath = join(repo, "site/.well-known/agent-tools.json");
  mkdirSync(join(repo, "site/.well-known"), { recursive: true });
  writeFileSync(manifestPath, buildProductionDiscoveryManifestContent());
  git(repo, ["add", "site/.well-known/agent-tools.json"]);

  const result = runGuard(repo, ["--staged"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mirrors match their source generator/u);
});

test("generated output guard rejects a drifted committed discovery mirror", () => {
  const repo = createRepo();
  const manifestPath = join(repo, "site/.well-known/agent-tools.json");
  mkdirSync(join(repo, "site/.well-known"), { recursive: true });
  writeFileSync(manifestPath, "{\"protocols\":[\"http\"]}\n");
  git(repo, ["add", "site/.well-known/agent-tools.json"]);

  const result = runGuard(repo, ["--staged"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /committed generated source mirror drifted/u);
  assert.match(result.stderr, /site\/\.well-known\/agent-tools\.json/u);
  assert.match(result.stderr, /byte-identical/u);

  const bypassAttempt = runGuard(repo, ["--staged"], { ALLOW_GENERATED_EDIT: "1" });
  assert.equal(bypassAttempt.status, 1, "the generic generated-output escape hatch must not bypass manifest truth");
  assert.match(bypassAttempt.stderr, /committed generated source mirror drifted/u);
});

test("generated output guard allows explicit env bypass", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "site/index.html"), "intentional generated update\n");
  git(repo, ["add", "site/index.html"]);

  const result = runGuard(repo, ["--staged"], { ALLOW_GENERATED_EDIT: "1" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /bypassed/);
});

test("generated output guard allows commit ranges with allow tag", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "frontend/index.html"), "intentional generated update\n");
  git(repo, ["add", "frontend/index.html"]);
  git(repo, ["commit", "-m", "Update generated surface [allow-generated]"]);

  const result = runGuard(repo, ["--range", "HEAD~1..HEAD"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /allow-generated/);
});

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), "generated-output-guard-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  mkdirSync(join(repo, "frontend"), { recursive: true });
  mkdirSync(join(repo, "site"), { recursive: true });
  writeFileSync(join(repo, "frontend/index.html"), "initial frontend\n");
  writeFileSync(join(repo, "site/index.html"), "initial site\n");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "Initial"]);
  return repo;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runGuard(cwd, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
