import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "app", "out");
const frontendDir = path.join(repoRoot, "frontend");

async function ensureOutExists() {
  const entries = await readdir(outDir).catch(() => null);
  if (!entries) {
    throw new Error(
      "app/out does not exist. Run the static operator build first with `npm run build:frontend`."
    );
  }
}

async function syncDirectory(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });

  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(sourceDir, { withFileTypes: true }),
    readdir(targetDir, { withFileTypes: true }).catch(() => [])
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

await ensureOutExists();
await syncDirectory(outDir, frontendDir);

console.log("Synced app/out operator assets into frontend/ without replacing the mounted directory.");
