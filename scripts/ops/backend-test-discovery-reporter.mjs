import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tap } from "node:test/reporters";

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(resolve(path));
  }
  return files.sort();
}

// Audit Node's actual per-file completion events, not a second interpretation
// of the package.json glob. A missing file is a failing run, even if all the
// tests that happened to be discovered passed. The separate HTTP smoke phase
// deliberately uses Node's normal reporter instead.
export default async function* backendDiscoveryReporter(events) {
  const executed = new Set();
  async function* recordFiles() {
    for await (const event of events) {
      if (event.type === "test:summary" && event.data.file) executed.add(resolve(event.data.file));
      yield event;
    }
  }
  yield* tap(recordFiles());
  const expected = await testFiles(resolve("src"));
  const actual = [...executed].sort();
  const missing = expected.filter((file) => !executed.has(file));
  yield `# backend-test-discovery expected=${expected.length} executed=${actual.length} missing=${missing.length}\n`;
  assert.deepEqual(actual, expected, `Backend test files were not all executed: ${missing.map((file) => relative(process.cwd(), file)).join(", ")}`);
}
