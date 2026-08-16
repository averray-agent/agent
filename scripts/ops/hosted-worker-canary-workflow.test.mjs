import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/hosted-worker-canary.yml", import.meta.url)
);

test("mainnet canary owns a dedicated refresh chain and preserves testnet auth", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /ADMIN_REFRESH_TOKEN_OP: op:\/\/mainnet-smoke\/admin-refresh-token-worker-canary\/password/u,
    "mainnet canary must use its own refresh chain"
  );
  assert.match(
    workflow,
    /OP_SERVICE_ACCOUNT_TOKEN: \$\{\{ secrets\.OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE \}\}/u,
    "mainnet canary must use the mainnet-smoke service account"
  );
  assert.match(
    workflow,
    /if: \$\{\{ steps\.trigger_decision\.outputs\.should_run == 'true' && \(vars\.WORKER_CANARY_PROFILE \|\| 'testnet'\) != 'mainnet' \}\}[\s\S]{0,300}ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u,
    "legacy prod-smoke JWT loading must remain testnet-only"
  );
  assert.match(
    workflow,
    /if \[ "\$WORKER_CANARY_PROFILE" = "mainnet" \]; then\s+AVERRAY_TOKEN="\$AVERRAY_TOKEN" \.\/scripts\/ops\/check-hosted-stack\.sh/u,
    "mainnet hosted checks must receive the refresh-minted access token"
  );
  assert.match(
    workflow,
    /internal smoke runner[\s\S]{0,120}op:\/\/mainnet-smoke\/admin-refresh-token\/password chain/u,
    "workflow must document that the internal smoke runner owns a different refresh chain"
  );
});

test("canary workflow fails closed on missing evidence and summarizes timed settlement", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /No worker-canary evidence file was produced\.[\s\S]{0,180}exit 1/u,
    "a missing failure artifact must fail the evidence step"
  );
  assert.match(workflow, /settle_polls=.*\.stages\.settle\.pollCount/u);
  assert.match(workflow, /settle_ms=.*\.stages\.settle\.elapsedMs/u);
  assert.match(workflow, /if-no-files-found: error/u);
});

test("scheduled and post-deploy canaries leave settlement ownership to the auto-verifier", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /WORKER_CANARY_VERIFY_MODE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.verify_mode \|\| 'auto' \}\}/u,
    "non-dispatch canaries must not race /verifier/run against the in-process auto-verifier"
  );
});

test("post-deploy canary requires a real deploy result and reports every skip reason", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /cron: "37 6 \* \* \*"/u, "daily heartbeat time must remain unchanged");
  assert.match(workflow, /permissions:\s+actions: read\s+contents: read/u);
  assert.match(
    workflow,
    /gh run download "\$TRIGGER_WORKFLOW_RUN_ID"[\s\S]{0,180}--name production-deploy-result/u,
    "post-deploy trigger must consume the completed deploy's result artifact",
  );
  assert.match(
    workflow,
    /production-deploy-result artifact could not be read[\s\S]{0,100}Refusing to guess/u,
    "missing deploy truth must fail visibly rather than silently skip",
  );
  assert.match(
    workflow,
    /name: Summarize skipped canary[\s\S]{0,1400}Gas-spending lifecycle steps executed:.*false/u,
    "every decision skip must explain itself in the run summary",
  );
  assert.match(
    workflow,
    /name: Run hosted worker canary\s+if: \$\{\{ steps\.trigger_decision\.outputs\.should_run == 'true' \}\}/u,
    "the paid lifecycle step must be downstream of the pure trigger decision",
  );
});

test("post-deploy canary debounces on durable green SHA artifacts", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /artifact_name="hosted-worker-canary-green-\$\{WORKER_CANARY_PROFILE\}-\$\{DEPLOYED_SHA\}"[\s\S]{0,520}expired == false and \.name == \$name/u,
    "debounce must look up a non-expired green marker for the exact deployed SHA",
  );
  assert.match(
    workflow,
    /name: Upload green SHA debounce marker[\s\S]{0,360}name: hosted-worker-canary-green-\$\{\{ vars\.WORKER_CANARY_PROFILE \|\| 'testnet' \}\}-\$\{\{ steps\.trigger_decision\.outputs\.deployed_sha \}\}/u,
    "a successful lifecycle walk must persist its exact SHA marker",
  );
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name == 'workflow_run'[\s\S]{0,180}steps\.canary_target\.outputs\.deploy_changed == 'true'/u,
    "daily and manual runs must not be suppressed by the post-deploy debounce lookup",
  );
});

test("post-deploy trigger skips docs-only diffs and recent green mainnet canaries", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /git diff --name-only "\$old_sha" "\$deployed_sha"/u);
  assert.match(workflow, /WORKER_CANARY_CHANGED_FILES_JSON:/u);
  assert.match(workflow, /hosted-worker-canary-green-mainnet-/u);
  assert.match(workflow, /WORKER_CANARY_RECENT_GREEN_MAINNET_EXISTS:/u);
  assert.match(workflow, /6 hours/u);
});

test("the workflow exposes the 0.1 USDC default and reports payout recovery disposition", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /reward_amount:\s+description: Reward in USDC for the disposable canary job \(blank = 0\.1\)\.[\s\S]{0,120}default: ""/u,
    "the dispatch contract must name the script's 0.1 USDC default"
  );
  assert.match(workflow, /payout_disposition=.*\.payoutDisposition\.status/u);
  assert.match(workflow, /Payout disposition:.*payout_disposition/u);
  assert.match(
    workflow,
    /payout recovery|recovered proof-costs|reward bank/iu,
    "the workflow must explain that ephemeral payouts are recovered into the reward bank"
  );
});
