import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const generatedPath = ["site", "llms.txt"].join("/");
function assertNoGeneratedReads(source, path) {
  for (const line of source.split("\n")) {
    if (!line.includes(generatedPath)) continue;
    // The deploy test WRITES a synthetic output file to test served-byte parity.
    // It must not become a content reader of the committed generated artifact.
    const fixtureWrite = path === "scripts/ops/deploy-production.test.mjs"
      && line.trim().startsWith(`await writeFile(join(appRoot, "${generatedPath}"),`);
    assert.ok(fixtureWrite, `${path}: read the maintained llms source or fresh build output, not ${generatedPath}`);
  }
}

test("llms consumers never read the committed generated artifact", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "mcp-server", "scripts", "marketing", "sdk", "app", "indexer", "packages"], {
    cwd: root, encoding: "utf8"
  }).split("\0").filter((path) => /\.(?:[cm]?[jt]sx?|astro)$/u.test(path));
  for (const path of files) {
    const url = new URL(path, root);
    if (existsSync(url)) assertNoGeneratedReads(readFileSync(url, "utf8"), path);
  }
  for (const reader of ["readFile", "readFileSync"]) {
    assert.throws(() => assertNoGeneratedReads(`${reader}(new URL("${generatedPath}", root), "utf8")`, "test.js"), assert.AssertionError);
  }
});
