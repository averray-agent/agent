import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("backend image ships the Witness tree at the lazy import path", async () => {
  const dockerfile = await readFile(resolve(REPO_ROOT, "mcp-server/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY witness \/witness$/mu);
});
