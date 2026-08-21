import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProductionDiscoveryManifestContent } from "./ops/discovery-manifest-file.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "marketing", "dist");
const siteDir = path.join(repoRoot, "site");

// Top-level entries owned wholesale by the Astro build. `_astro` is synced as a
// directory, so stale content-hashed assets get pruned.
// `fonts` carries the self-hosted webfonts from marketing/public/fonts —
// standalone site/ pages (agent.html, schema docs) reference them too.
const generatedEntries = ["index.html", "_astro", "console-stream.js", "reader-fetch.js", "receipt-reader.js", "trust-providers.js", "transparency-reader.js", "verify-reader.js", "fonts", "polkadot-mark.svg"];

// These nested files are generated too, but they live in directories that also
// hold hand-authored files — schema reference docs, badge SVGs, and potentially
// other `.well-known` resources. They are copied file-by-file rather than via
// syncDirectory, which prunes anything in the target that the source does not
// have and would delete those siblings.
const generatedNestedFiles = [
  "agents/index.html",
  "builders/index.html",
  "schemas/index.html",
  "trust/index.html",
  "privacy/index.html",
  "imprint/index.html",
  "transparency/index.html",
  "receipts/index.html",
  "verify/index.html",
  "proof-to-pay/index.html",
  ".well-known/agent-tools.json",
];

async function ensureDistExists() {
  const entries = await readdir(distDir).catch(() => null);
  if (!entries) {
    throw new Error(
      "marketing/dist does not exist. Run the Astro build first with `npm run build:marketing`."
    );
  }
}

async function syncDirectory(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });

  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(sourceDir, { withFileTypes: true }),
    readdir(targetDir, { withFileTypes: true }).catch(() => []),
  ]);
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

  await Promise.all(
    targetEntries
      .filter((entry) => !sourceNames.has(entry.name))
      .map((entry) => rm(path.join(targetDir, entry.name), { recursive: true, force: true }))
  );

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await syncDirectory(sourcePath, targetPath);
      continue;
    }
    await cp(sourcePath, targetPath, { force: true });
  }
}

async function syncEntry(entryName) {
  const source = path.join(distDir, entryName);
  const target = path.join(siteDir, entryName);

  const entries = await readdir(source, { withFileTypes: true }).catch(() => null);
  if (entries) {
    await syncDirectory(source, target);
    return;
  }

  await cp(source, target, { force: true });
}

await ensureDistExists();
const distDiscoveryManifest = path.join(distDir, ".well-known", "agent-tools.json");
await mkdir(path.dirname(distDiscoveryManifest), { recursive: true });
await writeFile(distDiscoveryManifest, buildProductionDiscoveryManifestContent());
await mkdir(siteDir, { recursive: true });

for (const entry of generatedEntries) {
  await syncEntry(entry);
}

for (const relativePath of generatedNestedFiles) {
  const source = path.join(distDir, relativePath);
  const target = path.join(siteDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

console.log("Synced marketing/dist landing assets into site/ without replacing mounted directories.");
