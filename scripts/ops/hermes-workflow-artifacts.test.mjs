import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("Hermes post-deploy verification keeps the full log as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/deploy-production.yml"), "utf8");

  assert.match(workflow, /name: Upload Hermes post-deploy log/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/u);
  assert.match(workflow, /name: hermes-post-deploy-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: hermes-post-deploy\.log/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("Hermes PR handoff keeps the full log as a correlation-id artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hermes-pr-handoff.yml"), "utf8");

  assert.match(workflow, /name: Upload Hermes handoff log/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/u);
  assert.match(workflow, /name: hermes-handoff-\$\{\{ steps\.pr\.outputs\.correlation_id \}\}/u);
  assert.match(workflow, /path: hermes-handoff\.log/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted service-token proof uploads sanitized evidence as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-service-token-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE/u);
  assert.match(workflow, /ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u);
  assert.match(workflow, /CHECK_SERVICE_TOKEN_PROOF: "1"/u);
  assert.match(workflow, /SERVICE_TOKEN_PROOF_EVIDENCE_FILE: artifacts\/service-token-proof-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /ADMIN_JWT="\$ADMIN_JWT_OP" \.\/scripts\/ops\/check-hosted-stack\.sh/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/u);
  assert.match(workflow, /name: hosted-service-token-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \$\{\{ env\.SERVICE_TOKEN_PROOF_EVIDENCE_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});
