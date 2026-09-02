#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  schemaRefToJobSchemaPath
} from "../../mcp-server/src/core/job-schema-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const docsDir = path.join(repoRoot, "docs/schemas/jobs");
const checkOnly = process.argv.includes("--check");

await mkdir(docsDir, { recursive: true });

const expected = new Map(
  listBuiltinJobSchemas().map((entry) => {
    const schemaPath = schemaRefToJobSchemaPath(entry.$id);
    const fileName = path.basename(schemaPath);
    const schema = getPublicBuiltinJobSchemaByName(fileName);
    return [fileName, `${JSON.stringify(schema, null, 2)}\n`];
  })
);

let drifted = false;

for (const [fileName, content] of expected) {
  const file = path.join(docsDir, fileName);
  const current = await readFile(file, "utf8").catch(() => "");
  if (current === content) {
    continue;
  }

  drifted = true;
  const relative = path.relative(repoRoot, file);
  if (checkOnly) {
    console.error(`${relative} is not in sync with the runtime job schema registry.`);
    continue;
  }

  await writeFile(file, content);
  console.log(`Synced ${relative}`);
}

const existing = await readdir(docsDir).catch(() => []);
for (const fileName of existing.filter((name) => name.endsWith(".json")).sort()) {
  if (expected.has(fileName)) {
    continue;
  }
  drifted = true;
  console.error(`docs/schemas/jobs/${fileName} is not backed by the runtime job schema registry.`);
}

if (checkOnly && drifted) {
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("Job schemas are in sync.");
} else if (drifted) {
  console.log("Job schema docs synced.");
}
