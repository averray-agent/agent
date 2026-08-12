import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

test("hosted signer funding uses the current mainnet KMS env and pins its expected identity", async () => {
  const workflow = await readFile(
    join(repoRoot, ".github/workflows/hosted-signer-liquidity-funding.yml"),
    "utf8"
  );

  assert.match(workflow, /-f \/srv\/agent-stack\/app\/deploy\/docker-compose\.mainnet\.yml/u);
  assert.match(workflow, /\n\s+mainnet-backend \\\n/u);
  assert.match(workflow, /expected_signer=\$\(jq -er/u);
  assert.match(workflow, /mode_args\+=\(--expected-signer "\$expected_signer"\)/u);

  assert.doesNotMatch(workflow, /-f \/srv\/agent-stack\/docker-compose\.yml/u);
  assert.doesNotMatch(workflow, /\n\s+backend \\\n/u);
});
