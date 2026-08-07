import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/deploy-production.yml", import.meta.url)
);

test("production deploy selects smoke auth from the durable live network", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /sudo \.\/scripts\/ops\/flip-caddy-network\.sh status/u,
    "deploy must read the persisted Caddy selector"
  );
  assert.match(
    workflow,
    /testnet:420420417:true\|mainnet:420420419:true/u,
    "selector resolution must fail closed on network, chain, and route consistency"
  );
  assert.match(
    workflow,
    /if: steps\.live_network\.outputs\.network == 'testnet'[\s\S]{0,400}ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u,
    "legacy ADMIN_JWT must be loaded only for testnet"
  );
  assert.match(
    workflow,
    /ADMIN_REFRESH_TOKEN_OP: op:\/\/mainnet-smoke\/admin-refresh-token-production-deploy\/password/u,
    "mainnet deploy must own a dedicated refresh chain"
  );
  assert.match(
    workflow,
    /OP_SERVICE_ACCOUNT_TOKEN: \$\{\{ secrets\.OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE \}\}/u,
    "mainnet deploy must use the read/write mainnet-smoke service account"
  );
  assert.match(
    workflow,
    /token="\$\(node scripts\/ops\/get-admin-refresh-token\.mjs\)"[\s\S]{0,500}printf 'AVERRAY_TOKEN=%s\\n' "\$token" >> "\$GITHUB_ENV"/u,
    "mainnet access token must come from the persist-then-proceed helper"
  );
  assert.match(
    workflow,
    /testnet\)\s+deploy_admin_jwt="\$\{ADMIN_JWT_OP:-\}"[\s\S]{0,160}mainnet\)\s+deploy_averray_token="\$\{AVERRAY_TOKEN:-\}"/u,
    "only the credential selected for the durable live network may reach the VPS"
  );
  assert.match(
    workflow,
    /ADMIN_JWT=%q AVERRAY_TOKEN=%q/u,
    "deploy must pass the selected token class explicitly"
  );
});

test("production deploy exposes and uploads its running-system change result", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /outputs:\s+deployed: \$\{\{ steps\.deploy_production\.outputs\.changed \}\}\s+new_sha: \$\{\{ steps\.deploy_production\.outputs\.new_sha \}\}/u);
  assert.match(
    workflow,
    /id: deploy_production[\s\S]{0,7000}grep -E '\^AVERRAY_DEPLOY_RESULT='/u,
    "workflow must capture the deploy script's runtime outcome rather than infer from changed paths",
  );
  assert.match(
    workflow,
    /Deploy completed without an AVERRAY_DEPLOY_RESULT record; refusing to guess/u,
    "missing runtime outcome must fail closed",
  );
  assert.match(
    workflow,
    /name: Upload production deployment result[\s\S]{0,260}name: production-deploy-result/u,
    "workflow_run consumers need a durable bridge because job outputs are not in that event payload",
  );
});

test("production deploy maps a manual component list to forced RUN toggles", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /components:[\s\S]{0,300}default: auto[\s\S]{0,120}type: string/u,
    "workflow_dispatch must expose a comma-separated component selector"
  );
  assert.match(
    workflow,
    /DEPLOY_COMPONENTS:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.components\s*\|\|\s*'auto'\s*\}\}/u,
    "automatic deploys must retain auto component detection"
  );
  assert.match(
    workflow,
    /node scripts\/ops\/resolve-deploy-components\.mjs "\$DEPLOY_COMPONENTS" "\$DEPLOY_RUN_INDEXER"/u,
    "manual selections must be validated before reaching the VPS"
  );
  assert.match(
    workflow,
    /RUN_BACKEND=%q RUN_FRONTEND=%q RUN_INDEXER=%q RUN_SITE=%q RUN_CADDY=%q/u,
    "every component toggle must cross the SSH boundary explicitly"
  );
  for (const variable of ["run_backend", "run_frontend", "run_indexer", "run_site", "run_caddy"]) {
    assert.match(workflow, new RegExp(`"\\$${variable}"`, "u"), `${variable} must be forwarded`);
  }
});
