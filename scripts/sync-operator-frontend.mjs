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

await ensureOutExists();
await rm(frontendDir, { recursive: true, force: true });
await mkdir(frontendDir, { recursive: true });
await cp(outDir, frontendDir, { recursive: true });

console.log("Synced app/out operator assets into frontend/.");
