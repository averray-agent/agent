import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const runsComponentsDir = resolve(appRoot, "components", "runs");

test("runs components do not hardcode DOT units", () => {
  const offenders = componentFiles(runsComponentsDir)
    .map((file) => ({
      file,
      content: readFileSync(file, "utf8"),
    }))
    .filter(({ content }) => content.includes("DOT"))
    .map(({ file }) => relative(appRoot, file));

  assert.deepEqual(offenders, []);
});

test("runs summary chrome does not fabricate freshness or wallet metrics", () => {
  const queue = readFileSync(
    resolve(runsComponentsDir, "RunQueueTable.tsx"),
    "utf8"
  );
  const recommendations = readFileSync(
    resolve(runsComponentsDir, "RecommendationRail.tsx"),
    "utf8"
  );

  assert.doesNotMatch(queue, /Updated.*2s ago/u);
  assert.doesNotMatch(queue, /assigned to you/u);
  assert.doesNotMatch(recommendations, /your reputation/u);
});

function componentFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}
