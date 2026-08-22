import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCache = mkdtempSync(join(tmpdir(), "averray-mcp-pack-"));

try {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_update_notifier: "false"
    }
  });
  const [pack] = JSON.parse(output);
  const files = pack.files.map(({ path }) => path).sort();
  const expected = ["README.md", "bin/averray-mcp.js", "package.json"];

  assert.deepEqual(files, expected, "@averray/mcp pack contents changed");
  console.log(`@averray/mcp dry pack contains exactly: ${files.join(", ")}`);
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
