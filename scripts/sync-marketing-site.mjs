import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "marketing", "dist");
const siteDir = path.join(repoRoot, "site");

const generatedEntries = ["index.html", "_astro", "console-stream.js"];

async function ensureDistExists() {
  const entries = await readdir(distDir).catch(() => null);
  if (!entries) {
    throw new Error(
      "marketing/dist does not exist. Run the Astro build first with `npm run build:marketing`."
    );
  }
}

async function syncEntry(entryName) {
  const source = path.join(distDir, entryName);
  const target = path.join(siteDir, entryName);

  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

await ensureDistExists();
await mkdir(siteDir, { recursive: true });

for (const entry of generatedEntries) {
  await syncEntry(entry);
}

console.log("Synced marketing/dist landing assets into site/.");
