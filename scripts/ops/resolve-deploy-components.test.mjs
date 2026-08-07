import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { resolveDeployComponents } from "./resolve-deploy-components.mjs";

const SCRIPT = resolve("scripts/ops/resolve-deploy-components.mjs");

test("auto preserves today's component detection and the legacy indexer override", () => {
  assert.deepEqual(resolveDeployComponents("auto"), {
    backend: "auto",
    frontend: "auto",
    indexer: "auto",
    site: "auto",
    caddy: "auto"
  });
  assert.equal(
    resolveDeployComponents("auto", { legacyRunIndexer: "1" }).indexer,
    "1"
  );
});

test("an explicit list forces selected components and disables every other component", () => {
  assert.deepEqual(resolveDeployComponents(" site, backend "), {
    backend: "1",
    frontend: "0",
    indexer: "0",
    site: "1",
    caddy: "0"
  });
});

test("invalid or conflicting dispatch selections fail before deployment", () => {
  assert.throws(
    () => resolveDeployComponents("site,unknown"),
    /Unknown deploy component/u
  );
  assert.throws(
    () => resolveDeployComponents("site", { legacyRunIndexer: "1" }),
    /cannot both be explicit/u
  );

  const cli = spawnSync(process.execPath, [SCRIPT, "site,unknown"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Supported: backend, frontend, indexer, site, caddy/u);
});
