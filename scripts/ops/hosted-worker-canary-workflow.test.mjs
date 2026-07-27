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
    /if: \$\{\{ \(vars\.WORKER_CANARY_PROFILE \|\| 'testnet'\) != 'mainnet' \}\}[\s\S]{0,300}ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u,
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
