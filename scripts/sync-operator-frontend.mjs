import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "app", "out");
const frontendDir = path.join(repoRoot, "frontend");
const nextConfigPath = path.join(repoRoot, "app", "next.config.ts");
const exportedRootPath = path.join(outDir, "index.html");

async function ensureOutExists() {
  const entries = await readdir(outDir).catch(() => null);
  if (!entries) {
    throw new Error(
      "app/out does not exist. Run the static operator build first with `npm run build:frontend`."
    );
  }
}

async function ensureExportContainsBuildMarker() {
  const [nextConfig, exportedRoot] = await Promise.all([
    readFile(nextConfigPath, "utf8"),
    readFile(exportedRootPath, "utf8")
  ]);
  const marker = nextConfig.match(/NEXT_BUILD_ID\s*\?\?\s*"([^"]+)"/u)?.[1];

  if (!marker) {
    throw new Error("app/next.config.ts does not declare a default NEXT_BUILD_ID marker.");
  }
  if (!exportedRoot.includes(marker)) {
    throw new Error(
      `app/out/index.html does not contain the configured operator build marker "${marker}".`
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
await ensureExportContainsBuildMarker();
await syncDirectory(outDir, frontendDir);

console.log("Synced app/out operator assets into frontend/ without replacing the mounted directory.");
