import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts/ops/check-hosted-stack.sh");
const REDEPLOY_FRONTEND_SCRIPT = join(REPO_ROOT, "scripts/ops/redeploy-frontend.sh");
const NEXT_CONFIG = join(REPO_ROOT, "app/next.config.ts");

const ADDRESSES = {
  escrowCore: `0x${"11".repeat(20)}`,
  agentAccountCore: `0x${"22".repeat(20)}`,
  token: `0x${"33".repeat(20)}`,
  feeRecipient: `0x${"44".repeat(20)}`
};

async function runHostedStackFixture({
  autoVerifierOk,
  warnings = [],
  // Per-request response sequences. Entry N answers request N+1 (the last
  // entry repeats); an entry may be a document or a function of the default
  // document. This is how a deploy-time transient is staged: a degraded
  // first read, a recovered second one.
  healthResponses = null,
  posterOnboardingResponses = null,
  healthTransportFailure = null,
  timeoutSec = "5",
  htmlCacheControl = "no-cache",
  versionedAssetCacheControl = "public, max-age=31536000, immutable",
  poolStatus = 200,
  operatorToken = "",
  accountUnauthenticatedOk = false,
  receiptRscStatus = 200,
  pool = {
    available: true,
    chainId: 1,
    disclosure: { statement: "Technical pilot. Principal at risk. No depositor protection." }
  },
  creditConfigured = false,
  adminStatus = {
    maintenance: { policy: { enabled: true, risk: { defaultClaimStakeBps: 100, claimFeeBps: 50 } } },
    xcmSettlementWatcher: { enabled: true, pendingCount: 0, running: true },
    xcmObservationRelay: { enabled: false, running: false, lastError: null, lastSyncedAt: null }
  },
  creditStatus = 200,
  indexerHeadAgeSec = 60,
  indexerHeadBlock = 20_521_542,
  checkIndexerSync = "1",
  extraEnv = {},
  credit = {
    available: true,
    chainId: 1,
    creditPool: `0x${"55".repeat(20)}`,
    wallet: { outstanding: { raw: "0", decimals: 6 } },
    receiptGraph: {
      wallet: {
        cash: { outstanding: { raw: "0", decimals: 6 } },
        posting: { outstanding: { raw: "0", decimals: 6 } }
      }
    },
    disclosure: { statement: "Technical pilot. Principal at risk. No depositor protection." }
  }
}) {
  const health = {
    status: "ok",
    warnings,
    auth: { chainId: 1 },
    addresses: {
      escrowCore: ADDRESSES.escrowCore,
      agentAccountCore: ADDRESSES.agentAccountCore,
      token: ADDRESSES.token
    },
    components: {
      stateStore: { ok: true },
      submittedJobAutoVerifier: { ok: autoVerifierOk }
    }
  };
  if (creditConfigured) health.addresses.creditPool = credit.creditPool;
  const onboarding = {
    name: "Averray fixture",
    protocols: ["http"],
    tools: ["getAccountPosition", "buildWithdrawTransactions"],
    onboarding: {
      withdrawEarnings: {
        statement: "Withdraw via buildWithdrawTransactions — your signature and broadcast, any destination. Eligible workers can request Averray's one-time first-withdrawal DOT grant from that same withdrawal intent.",
        retentionNotGates: "whatYourBalanceCanDo is informational only. It never delays, conditions, prices, or adds steps to withdrawal, and complete templates remain present."
      }
    },
    externalBounties: {
      posterOnboarding: "/poster/onboarding",
      cancellation: {
        selfServeCancel: true,
        method: "cancelOpenJob(bytes32)",
        scope: "any Open job",
        minimumOpenSeconds: 3600
      },
      claimBond: { available: true },
      disputeWindow: {
        available: true,
        remedy: {
          onChain: {
            available: true,
            abiFragment: "function openDispute(bytes32 jobId)"
          },
          brokeredPath: { reason: "no_worker_reachable_brokered_open_dispute_route" }
        }
      }
    }
  };
  const posterOnboarding = {
    mode: "open",
    chainId: 1,
    escrowCore: ADDRESSES.escrowCore,
    agentAccountCore: ADDRESSES.agentAccountCore,
    token: { address: ADDRESSES.token },
    economics: {
      feeSemantics: "poster_additive",
      protocolFeeBps: 100,
      posterFeeBps: 100,
      posterFeeFloorRaw: "50000",
      feeRecipient: ADDRESSES.feeRecipient,
      minRewardUsdc: "1",
      draftTtlHours: 24,
      quotePersistence: "demand_signal_only_until_funded",
      quoteIdentity: "poster_and_content_hash"
    },
    cancellation: {
      selfServeCancel: true,
      method: "cancelOpenJob(bytes32)",
      onChain: {
        address: ADDRESSES.escrowCore,
        abiFragment: "function cancelOpenJob(bytes32 jobId)",
        args: ["<jobId>"],
        value: "0"
      },
      scope: "any Open job",
      minimumOpenSeconds: 3600
    },
    workerFacts: {
      claimBond: { available: true, stakeBps: 100, feeBps: 50, minFeeRaw: "1" },
      gasPolicy: { operatorBrokeredGas: false, appliesTo: "all externally posted jobs" },
      disputeWindow: {
        available: true,
        seconds: 3600,
        remedy: {
          onChain: {
            available: true,
            abiFragment: "function openDispute(bytes32 jobId)",
            address: ADDRESSES.escrowCore
          },
          brokeredPath: {
            available: false,
            reason: "no_worker_reachable_brokered_open_dispute_route"
          }
        }
      }
    },
    flow: [{
      id: "fund",
      posterReservedRawFormula: "rewardRaw + opsReserveRaw + contingencyReserveRaw + max(floor(rewardRaw * economics.posterFeeBps / 10000), economics.posterFeeFloorRaw)",
      depositAmountFormula: "max(posterReservedRaw - positions(poster, token).liquid, 0)",
      positionRead: { address: ADDRESSES.agentAccountCore },
      writes: [
        {
          abiFragment: "function approve(address spender, uint256 amount) returns (bool)",
          address: ADDRESSES.token,
          args: [ADDRESSES.agentAccountCore]
        },
        {
          abiFragment: "function deposit(address asset, uint256 amount)",
          address: ADDRESSES.agentAccountCore,
          args: [ADDRESSES.token]
        }
      ]
    }],
    liveReads: {
      asOf: new Date().toISOString(),
      protocolFeeBps: { status: "available" },
      feeRecipient: { status: "available" },
      claimBond: { status: "available" },
      disputeWindow: { status: "available" }
    }
  };

  const fixtures = new Map([
    ["/", "<html><head><title>Averray fixture</title></head></html>"],
    ["/agent-profile", "<html><head><title>Averray agent fixture</title></head></html>"],
    ["/reader-fetch.js?v=20260823", "window.AverrayReaderFetch = {};"],
    ["/receipts/junk", `<html><body>
      <div data-receipt-state="loading"></div>
      <a href="/receipts/0xe302d62bef7f96686bba5db4cfc44fc5743b5464706f2acbc0e6350929a62ce1">settled work receipt</a>
      <a href="/receipts/0x8a99c2e19b75a7e3b19e1aefb4448be162e89480d953c20ad813b8dda12797c0">verification receipt</a>
      <a href="/transparency/">transparency</a>
    </body></html>`],
    ["/app", "averray-operator"],
    ["/app/receipts/__next._tree.txt", "receipts route tree"],
    ["/.well-known/agent-tools.json", {
      discoveryUrl: "https://averray.com/.well-known/agent-tools.json",
      baseUrl: "https://api.averray.com",
      publicEndpoints: [{ path: "/poster/onboarding" }],
      authenticatedEndpoints: [],
      tools: [],
      onboarding: { posterEntrypoint: "https://api.averray.com/poster/onboarding" }
    }],
    ["/health", health],
    ["/mcp", {
      type: "mcp_protocol_endpoint",
      description: "This is an MCP protocol endpoint, not a browser page.",
      connect: {
        url: "https://api.averray.com/mcp",
        clientConfig: {
          mcpServers: { averray: { url: "https://api.averray.com/mcp" } }
        }
      },
      install: {
        npm: {
          package: "@averray/mcp",
          command: "npx -y @averray/mcp"
        },
        cursor: {
          deeplink: "cursor://anysphere.cursor-deeplink/mcp/install?name=averray&config=eyJ1cmwiOiJodHRwczovL2FwaS5hdmVycmF5LmNvbS9tY3AifQ%3D%3D",
          clientConfig: {
            mcpServers: { averray: { url: "https://api.averray.com/mcp" } }
          }
        },
        claudeCode: {
          command: "claude mcp add --transport http averray https://api.averray.com/mcp"
        },
        claudeDesktop: {
          clientConfig: {
            mcpServers: {
              averray: { command: "npx", args: ["-y", "@averray/mcp"] }
            }
          }
        }
      },
      plainHttpAlternative: {
        method: "GET",
        path: "/verify/profiles",
        url: "https://api.averray.com/verify/profiles"
      }
    }],
    ["/onboarding", onboarding],
    ["/poster/onboarding", posterOnboarding],
    ["/admin/status", adminStatus],
    ["/strategies", {
      status: "retired",
      retired: true,
      strategies: [],
      see: { pool: "/pool", onboarding: "/onboarding#buildVestedCapacity" }
    }],
    ["/account/position?asset=USDC", {
      available: true,
      account: {
        owner: ADDRESSES.feeRecipient,
        available: { raw: "10" },
        stakedOnOpenWork: { raw: "0" },
        statement: []
      },
      ownershipProof: { contract: "AgentAccountCore" },
      withdrawal: {
        http: { path: "/account/withdraw/transactions" },
        mcp: { tool: "buildWithdrawTransactions" }
      },
      whatYourBalanceCanDo: {
        retentionNotGates: { templatesRemainComplete: true, conditionsWithdrawal: false }
      }
    }]
  ]);
  const redirects = new Map([
    ["/site/onboarding", "https://api.averray.com/onboarding"],
    ["/site/health", "https://api.averray.com/health"],
    ["/site/jobs/tiers", "https://api.averray.com/jobs/tiers"],
    ["/site/verify/profiles", "https://api.averray.com/verify/profiles"],
    ["/redirect/app/transparency", "https://averray.com/transparency/"],
    ["/redirect/app/transparency/", "https://averray.com/transparency/"],
    ["/redirect/app/receipts/0xabc123def4567890abc123def4567890abc123de", "https://averray.com/receipts/0xabc123def4567890abc123def4567890abc123de"],
    ["/redirect/app/jobs", "https://app.averray.com/work"],
    ["/redirect/app/jobs/example-job", "https://app.averray.com/work"],
    ["/redirect/site/work", "https://app.averray.com/work"],
    ["/redirect/site/work/example-job", "https://app.averray.com/work"],
    ["/site/get-started", "https://averray.com/agents/"],
    ["/app/post", "https://app.averray.com/poster/"],
    ["/app/poster/jobs", "https://app.averray.com/poster/"],
    ["/app/verify", "https://app.averray.com/runs/"],
    ["/app/withdraw", "https://app.averray.com/work-withdraw/"],
    ["/app/withdraw/", "https://app.averray.com/work-withdraw/"],
    ["/app/earnings", "https://app.averray.com/work-withdraw/"],
    ["/app/earnings/", "https://app.averray.com/work-withdraw/"],
    ["/redirect/www/mcp", "https://averray.com/builders/#install"],
    ["/redirect/www/install", "https://averray.com/builders/#install"],
    ["/redirect/www/cursor", "https://averray.com/builders/#install"],
    ["/redirect/www/claude", "https://averray.com/builders/#install"],
    ["/redirect/app/mcp", "https://averray.com/builders/#install"],
    ["/redirect/app/install", "https://averray.com/builders/#install"],
    ["/redirect/app/connect", "https://averray.com/builders/#install"],
    ["/api/jobs/open", "https://api.averray.com/jobs"]
  ]);
  const sequenced = new Map([
    ["/health", { base: health, responses: healthResponses }],
    ["/poster/onboarding", { base: posterOnboarding, responses: posterOnboardingResponses }]
  ]);
  const requestCounts = new Map();
  const server = createServer((request, response) => {
    const requestCount = (requestCounts.get(request.url) ?? 0) + 1;
    requestCounts.set(request.url, requestCount);
    const sequence = sequenced.get(request.url);
    if (sequence?.responses) {
      const entry = sequence.responses[Math.min(requestCount, sequence.responses.length) - 1];
      const document = typeof entry === "function" ? entry(structuredClone(sequence.base)) : entry;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(document));
      return;
    }
    if (request.url === "/health" && (
      healthTransportFailure === "always_http_503"
      || (requestCount === 1 && healthTransportFailure === "http_503")
    )) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream_unavailable" }));
      return;
    }
    if (request.url === "/health" && requestCount === 1 && healthTransportFailure === "timeout") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(health));
      }, 75);
      return;
    }
    if (redirects.has(request.url)) {
      response.writeHead(301, { location: redirects.get(request.url) });
      response.end();
      return;
    }
    if (request.url === "/app/receipts/__next._tree.txt" && receiptRscStatus !== 200) {
      response.writeHead(receiptRscStatus, receiptRscStatus >= 300 && receiptRscStatus < 400
        ? { location: "https://averray.com/receipts/__next._tree.txt" }
        : {});
      response.end();
      return;
    }
    if (request.url === "/pool") {
      response.writeHead(poolStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(pool));
      return;
    }
    if (request.url.startsWith("/account/") && !request.headers.authorization && !accountUnauthenticatedOk) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "auth_required", reason: "wallet_session_required" }));
      return;
    }
    if (request.url === "/account/withdraw/transactions" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        available: true,
        templates: [{
          unsigned: true,
          decoded: { function: "withdraw(address,uint256)", args: { amount: "1" } },
          gas: { status: "measured" }
        }],
        whatYourBalanceCanDo: { retentionNotGates: { templatesRemainComplete: true } }
      }));
      return;
    }
    if (request.url === "/credit") {
      response.writeHead(creditStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(credit));
      return;
    }
    if (request.url === "/indexer/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        polkadotHubMainnet: {
          id: 420420419,
          block: { number: indexerHeadBlock, timestamp: Math.floor(Date.now() / 1000) - indexerHeadAgeSec }
        }
      }));
      return;
    }
    const value = fixtures.get(request.url);
    if (value === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const headers = {
      "content-type": typeof value === "string" ? "text/html" : "application/json"
    };
    if (["/", "/agent-profile", "/receipts/junk"].includes(request.url)) {
      headers["cache-control"] = htmlCacheControl;
    }
    if (request.url === "/reader-fetch.js?v=20260823") {
      headers["content-type"] = "text/javascript";
      headers["cache-control"] = versionedAssetCacheControl;
    }
    response.writeHead(200, headers);
    response.end(typeof value === "string" ? value : JSON.stringify(value));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const env = {
      ...process.env,
      PUBLIC_SITE_URL: `${baseUrl}/`,
      PUBLIC_AGENT_PROFILE_URL: `${baseUrl}/agent-profile`,
      PUBLIC_VERSIONED_ASSET_URL: `${baseUrl}/reader-fetch.js?v=20260823`,
      PUBLIC_RECEIPT_JUNK_URL: `${baseUrl}/receipts/junk`,
      PUBLIC_ONBOARDING_REDIRECT_URL: `${baseUrl}/site/onboarding`,
      PUBLIC_HEALTH_REDIRECT_URL: `${baseUrl}/site/health`,
      PUBLIC_JOB_TIERS_REDIRECT_URL: `${baseUrl}/site/jobs/tiers`,
      PUBLIC_VERIFY_PROFILES_REDIRECT_URL: `${baseUrl}/site/verify/profiles`,
      APP_TRANSPARENCY_REDIRECT_URL: `${baseUrl}/redirect/app/transparency`,
      APP_TRANSPARENCY_SLASH_REDIRECT_URL: `${baseUrl}/redirect/app/transparency/`,
      APP_RECEIPT_REDIRECT_URL: `${baseUrl}/redirect/app/receipts/0xabc123def4567890abc123def4567890abc123de`,
      APP_RECEIPTS_RSC_URL: `${baseUrl}/app/receipts/__next._tree.txt`,
      APP_JOBS_REDIRECT_URL: `${baseUrl}/redirect/app/jobs`,
      APP_JOB_SUBPATH_REDIRECT_URL: `${baseUrl}/redirect/app/jobs/example-job`,
      PUBLIC_WORK_REDIRECT_URL: `${baseUrl}/redirect/site/work`,
      PUBLIC_WORK_SUBPATH_REDIRECT_URL: `${baseUrl}/redirect/site/work/example-job`,
      PUBLIC_GET_STARTED_REDIRECT_URL: `${baseUrl}/site/get-started`,
      DISCOVERY_URL: `${baseUrl}/.well-known/agent-tools.json`,
      APP_URL: `${baseUrl}/app`,
      APP_POST_REDIRECT_URL: `${baseUrl}/app/post`,
      APP_POSTER_JOBS_REDIRECT_URL: `${baseUrl}/app/poster/jobs`,
      APP_VERIFY_REDIRECT_URL: `${baseUrl}/app/verify`,
      APP_WITHDRAW_REDIRECT_URL: `${baseUrl}/app/withdraw`,
      APP_WITHDRAW_SLASH_REDIRECT_URL: `${baseUrl}/app/withdraw/`,
      APP_EARNINGS_REDIRECT_URL: `${baseUrl}/app/earnings`,
      APP_EARNINGS_SLASH_REDIRECT_URL: `${baseUrl}/app/earnings/`,
      WWW_MCP_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/www/mcp`,
      WWW_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/www/install`,
      WWW_CURSOR_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/www/cursor`,
      WWW_CLAUDE_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/www/claude`,
      APP_MCP_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/app/mcp`,
      APP_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/app/install`,
      APP_CONNECT_INSTALL_REDIRECT_URL: `${baseUrl}/redirect/app/connect`,
      API_HEALTH_URL: `${baseUrl}/health`,
      API_MCP_INFO_URL: `${baseUrl}/mcp`,
      API_POOL_URL: `${baseUrl}/pool`,
      API_ACCOUNT_POSITION_URL: `${baseUrl}/account/position?asset=USDC`,
      API_ACCOUNT_WITHDRAW_URL: `${baseUrl}/account/withdraw/transactions`,
      API_STRATEGIES_URL: `${baseUrl}/strategies`,
      API_CREDIT_URL: `${baseUrl}/credit`,
      API_ONBOARDING_URL: `${baseUrl}/onboarding`,
      API_POSTER_ONBOARDING_URL: `${baseUrl}/poster/onboarding`,
      API_JOBS_OPEN_REDIRECT_URL: `${baseUrl}/api/jobs/open`,
      API_ADMIN_STATUS_URL: `${baseUrl}/admin/status`,
      ADMIN_JWT: operatorToken,
      AVERRAY_TOKEN: "",
      CREDIT_DOOR_TOKEN: creditConfigured ? "fixture-operator-token" : "",
      INDEXER_STATUS_URL: `${baseUrl}/indexer/status`,
      CHECK_INDEXER: "0",
      CHECK_INDEXER_SYNC: checkIndexerSync,
      CHECK_BOOTSTRAP_INSTRUMENTATION: "0",
      CHECK_BOOTSTRAP_SELF_REPORT_SENT: "0",
      CHECK_PRODUCT_PROOF_GATE: "0",
      CHECK_SERVICE_TOKEN_PROOF: "0",
      CHECK_EXTERNAL_SCHEMA_PROOF: "0",
      CHECK_DISPUTE_VERDICT_PROOF: "0",
      CHECK_SIWE_FRESH_WALLET_PROOF: "0",
      CHECK_WORKER_CANARY_PROOF: "0",
      CHECK_METRICS_AUTH: "0",
      HOSTED_CURL_RETRY_BACKOFF_1_SEC: "0",
      HOSTED_CURL_RETRY_BACKOFF_2_SEC: "0",
      LIVE_READ_ATTEMPTS: "1",
      TRANSIENT_RECHECK_SLEEP_SEC: "0",
      TRANSIENT_RECHECK_MAX_SLEEP_SEC: "0",
      TIMEOUT_SEC: timeoutSec,
      ...extraEnv
    };

    const result = await new Promise((resolve, reject) => {
      const child = spawn("bash", [CHECK_SCRIPT], { cwd: REPO_ROOT, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { ...result, requestCounts: Object.fromEntries(requestCounts) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function extractShellMarkerDefault(source, label) {
  const match = source.match(
    /APP_EXPECTED_MARKER=\$\{APP_EXPECTED_MARKER:-(?:"([^"]+)"|'([^']+)'|([^}]+))\}/u
  );
  assert.ok(match, `${label} must declare an APP_EXPECTED_MARKER default`);
  return match[1] ?? match[2] ?? match[3];
}

test("operator build id and hosted deploy markers stay in parity", async () => {
  const [nextConfig, redeployScript, hostedCheckScript] = await Promise.all([
    readFile(NEXT_CONFIG, "utf8"),
    readFile(REDEPLOY_FRONTEND_SCRIPT, "utf8"),
    readFile(CHECK_SCRIPT, "utf8")
  ]);
  const buildId = nextConfig.match(/NEXT_BUILD_ID\s*\?\?\s*"([^"]+)"/u)?.[1];

  assert.ok(buildId, "app/next.config.ts must declare a default NEXT_BUILD_ID");
  assert.equal(extractShellMarkerDefault(redeployScript, "redeploy-frontend.sh"), buildId);
  assert.equal(extractShellMarkerDefault(hostedCheckScript, "check-hosted-stack.sh"), buildId);
});

test("hosted smoke refuses a cross-origin receipts client-navigation asset redirect", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    receiptRscStatus: 301,
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /receipts client-navigation asset returned HTTP 301/u);
});

test("hosted smoke rejects an unhealthy submitted-job verifier even with no warnings", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: false, warnings: [] });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.requestCounts["/health"], 1, "a parsed assertion failure must never retry");
});

test("hosted smoke retries an HTTP 5xx transport response and then applies assertions", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    healthTransportFailure: "http_503"
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.requestCounts["/health"], 2);
  assert.match(result.stderr, /HTTP 503.*attempt 1\/3/u);
});

test("hosted smoke retries a curl timeout and then applies assertions", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    healthTransportFailure: "timeout",
    timeoutSec: "0.02"
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.requestCounts["/health"], 2);
  assert.match(result.stderr, /timeout.*attempt 1\/3/u);
});

test("hosted smoke stays fail-closed after all transport retries fail", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    healthTransportFailure: "always_http_503"
  });

  assert.notEqual(result.code, 0);
  assert.equal(result.requestCounts["/health"], 3);
});

test("hosted smoke accepts a healthy submitted-job verifier", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [] });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Checking DepositPool door/u);
  assert.match(result.stdout, /\/health warnings: none/u);
  assert.match(result.stdout, /Hosted stack smoke check passed\./u);
});

// --- Deploy-time transients ---------------------------------------------------
//
// Production deploys on 2026-09-11/12 (runs 34605177569, 34639123465,
// 34694909418, 34707381954, 34711658754) died with a bare
// "##[error]Process completed with exit code 1" right after "Checking API
// health" or "Checking poster onboarding live facts", and the same check was
// green minutes later. Two mechanics, both pinned below:
//
//   * the verifier's in-memory failure streaks reset on a backend recreate and
//     go critical (submitted_session_persistently_skipped) at run 2, clearing a
//     run or two later;
//   * poster onboarding populates its fee/claim-bond/dispute-window facts only
//     from live chain reads, which report `unavailable` while the gateway warms.
//
// Each gets exactly ONE bounded re-read. indexer_stalled never does.

const VERIFIER_CRITICAL = Object.freeze({
  code: "submitted_session_persistently_skipped",
  severity: "critical",
  message: "Submitted-job auto-verifier is unhealthy (submitted_session_persistently_skipped); persistent submitted session count: 1."
});
const INDEXER_STALLED_CRITICAL = Object.freeze({
  code: "indexer_stalled",
  severity: "critical",
  message: "Indexer sync is stalled: the newest indexed block has not advanced for 1200s and is 1800s behind the chain."
});

function degradedVerifierHealth({
  consecutiveRuns = 2,
  intervalMs = 60_000,
  state = "submitted_session_persistently_skipped",
  nextRunAt = new Date(Date.now() + 200).toISOString(),
  extraWarnings = []
} = {}) {
  return (health) => ({
    ...health,
    warnings: [...extraWarnings, { ...VERIFIER_CRITICAL, code: state }],
    components: {
      ...health.components,
      submittedJobAutoVerifier: {
        ok: false,
        state,
        staleAfterMs: 180_000,
        enabled: true,
        running: true,
        mode: "live",
        intervalMs,
        nextRunAt,
        lastRunFinishedAt: new Date(Date.now() - 1_000).toISOString(),
        consecutiveSchedulerFailures: 0,
        pendingTimeoutCount: 0,
        persistentSubmittedFailureCount: 1,
        persistentSubmittedFailures: [{
          sessionId: "session-fixture",
          jobId: "job-fixture",
          reason: "settlement_not_ready",
          consecutiveRuns,
          lastSeenAt: new Date(Date.now() - 1_000).toISOString()
        }]
      }
    }
  });
}

// The document /poster/onboarding serves while the chain gateway is cold: the
// live-derived fee, claim-bond and dispute-window facts are absent or
// `available: false`, and `liveReads` says why (buildSnapshot in
// mcp-server/src/core/poster-onboarding.js).
function coldGatewayPosterOnboarding(poster, asOf = new Date().toISOString()) {
  const { protocolFeeBps, posterFeeBps, posterFeeFloorRaw, feeRecipient, ...economics } = poster.economics;
  const unavailable = { status: "unavailable", reason: "live_chain_read_failed" };
  return {
    ...poster,
    economics: { ...economics, availability: { protocolFeeBps: unavailable, feeRecipient: unavailable } },
    cancellation: {
      selfServeCancel: false,
      rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
      plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
    },
    workerFacts: {
      ...poster.workerFacts,
      claimBond: { available: false, reason: "live_chain_read_failed" },
      disputeWindow: {
        available: false,
        reason: "live_chain_read_failed",
        remedy: poster.workerFacts.disputeWindow.remedy
      }
    },
    liveReads: {
      asOf,
      protocolFeeBps: unavailable,
      feeRecipient: unavailable,
      claimBond: unavailable,
      disputeWindow: unavailable
    }
  };
}

test("a failing API-health clause is named with the warnings and fields it read", async () => {
  // consecutiveRuns 30 × 60s = 1800s: the verifier has watched this failure for
  // half an hour, far past the post-recreate grace, so it is refused outright.
  const result = await runHostedStackFixture({
    autoVerifierOk: false,
    healthResponses: [degradedVerifierHealth({ consecutiveRuns: 30 })]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/health"], 1, "an old verifier critical must not be re-read");
  assert.match(result.stdout, /\/health warnings: submitted_session_persistently_skipped \(critical\)/u);
  assert.match(result.stderr, /API health: clause 'auto_verifier_ok' failed\./u);
  assert.match(result.stderr, /asserted: \.components\.submittedJobAutoVerifier\.ok == true/u);
  assert.match(result.stderr, /observed: \{"ok":false,"state":"submitted_session_persistently_skipped"/u);
  assert.match(result.stderr, /"consecutiveRuns":30/u);
  assert.match(result.stderr, /refused on clause 'auto_verifier_ok' \(warnings seen: submitted_session_persistently_skipped \(critical\)\); not a deploy-time transient, so no re-read\./u);
});

test("a young verifier critical that clears on the single re-read passes", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    healthResponses: [degradedVerifierHealth({ consecutiveRuns: 2 }), (health) => health]
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.requestCounts["/health"], 2, "exactly one re-read");
  // The first read did fail its clause and the log must say so — the re-read
  // is a second look, not a suppression.
  assert.match(result.stderr, /API health: clause 'auto_verifier_ok' failed\./u);
  assert.match(result.stdout, /younger than VERIFIER_CRITICAL_GRACE_SEC=600s \(streak 2 run\(s\) x 60000ms\)/u);
  assert.match(result.stdout, /Re-reading \/health ONCE in 0s/u);
  assert.match(result.stdout, /\/health warnings on re-read: none/u);
  assert.match(result.stdout, /API health clauses passed on the re-read; the verifier critical cleared\./u);
  assert.match(result.stdout, /Hosted stack smoke check passed\./u);
});

test("a young verifier critical that does not clear fails after exactly one re-read", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: false,
    healthResponses: [degradedVerifierHealth({ consecutiveRuns: 2 }), degradedVerifierHealth({ consecutiveRuns: 3 })]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/health"], 2, "one re-read, never a loop");
  assert.match(result.stderr, /API health \(re-read\): clause 'auto_verifier_ok' failed\./u);
  assert.match(result.stderr, /refused on clause 'auto_verifier_ok' after the single bounded re-read \(warnings seen: submitted_session_persistently_skipped \(critical\); verifier streak 3 run\(s\) x 60000ms\)\./u);
  assert.equal(result.requestCounts["/indexer/status"], undefined, "the smoke stops at the refused clause");
});

test("the re-read waits for the verifier's next run, capped by TRANSIENT_RECHECK_MAX_SLEEP_SEC", async () => {
  const startedAt = Date.now();
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    healthResponses: [
      degradedVerifierHealth({ consecutiveRuns: 2, nextRunAt: new Date(Date.now() + 30_000).toISOString() }),
      (health) => health
    ],
    extraEnv: { TRANSIENT_RECHECK_SLEEP_SEC: "0", TRANSIENT_RECHECK_MAX_SLEEP_SEC: "2" }
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  // nextRunAt is 30s out (+5s margin) but the cap is 2s: the wait is 2s, not 35s.
  assert.match(result.stdout, /Re-reading \/health ONCE in 2s/u);
  assert.ok(Date.now() - startedAt >= 1_900, "the smoke actually slept for the announced 2s");
  assert.equal(result.requestCounts["/health"], 2);
});

test("indexer_stalled fails the API health check immediately, even beside a young verifier critical", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: false,
    healthResponses: [
      degradedVerifierHealth({ consecutiveRuns: 2, extraWarnings: [INDEXER_STALLED_CRITICAL] }),
      (health) => health
    ]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/health"], 1, "indexer_stalled is never re-read");
  assert.match(result.stdout, /\/health warnings: indexer_stalled \(critical\), submitted_session_persistently_skipped \(critical\)/u);
  assert.match(result.stderr, /API health: clause 'indexer_not_stalled' failed\./u);
  assert.match(result.stderr, /observed: \[\{"code":"indexer_stalled","severity":"critical"/u);
  assert.match(result.stderr, /refused on clause 'indexer_not_stalled' .*not a deploy-time transient, so no re-read\./u);
  assert.match(result.stderr, /docker restart agent-mainnet-indexer/u);
  assert.match(result.stderr, /INCIDENT_RESPONSE\.md/u);
  assert.equal(result.requestCounts["/indexer/status"], undefined, "refused before the sync-liveness step");
});

test("a pass that still carries an ungated critical is labelled, not presented as clean", async () => {
  // blockchain_unhealthy is a cold cache for the first seconds after a
  // recreate, so the smoke does not gate it — but a green run must still say
  // that /health carried it (truth boundary: passed-with-degraded-capability is
  // not the same state as passed).
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [{ code: "blockchain_unhealthy", severity: "critical", message: "Blockchain capability is unhealthy." }]
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.requestCounts["/health"], 1);
  assert.match(result.stdout, /\/health warnings: blockchain_unhealthy \(critical\)/u);
  assert.match(result.stdout, /WARNING: API health passed its gated clauses while \/health still carries critical warning\(s\) this smoke does not gate: blockchain_unhealthy\./u);
});

test("indexer_stalled alone is refused at the API health step", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [INDEXER_STALLED_CRITICAL]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/health"], 1);
  assert.match(result.stderr, /API health: clause 'indexer_not_stalled' failed\./u);
  assert.equal(result.requestCounts["/indexer/status"], undefined);
});

test("a verifier critical other than persistently_skipped is refused on the first read", async () => {
  // verification_timeout_pending is a hung verification, not post-recreate
  // noise (docs/INCIDENT_RESPONSE.md: restart the backend), so no re-read.
  const result = await runHostedStackFixture({
    autoVerifierOk: false,
    healthResponses: [
      degradedVerifierHealth({ consecutiveRuns: 2, state: "verification_timeout_pending" }),
      (health) => health
    ]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/health"], 1);
  assert.match(result.stderr, /API health: clause 'auto_verifier_ok' failed\./u);
  assert.match(result.stderr, /not a deploy-time transient, so no re-read\./u);
});

test("a poster-onboarding clause failing with live reads available is named and refused at once", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    posterOnboardingResponses: [
      (poster) => ({ ...poster, economics: { ...poster.economics, feeSemantics: "worker_deducted" } }),
      (poster) => poster
    ]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/poster/onboarding"], 1, "a contract regression is not re-fetched");
  assert.match(result.stderr, /Poster onboarding: clause 'fee_semantics_poster_additive' failed\./u);
  assert.match(result.stderr, /asserted: \.economics\.feeSemantics == "poster_additive"/u);
  assert.match(result.stderr, /observed: "worker_deducted"/u);
  assert.match(result.stderr, /refused on clause 'fee_semantics_poster_additive'; the document reports no unavailable live chain read \(live reads: protocolFeeBps=available, feeRecipient=available, claimBond=available, disputeWindow=available\), so this is a contract regression, not a warm-up transient — no re-fetch\./u);
});

test("poster onboarding re-fetches once while live reads are unavailable and passes when they recover", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    posterOnboardingResponses: [coldGatewayPosterOnboarding, (poster) => poster]
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.requestCounts["/poster/onboarding"], 2, "exactly one re-fetch");
  // The first failing clause is a live-derived one and its context shows the
  // unavailable read, so the log names the cause without a second document.
  assert.match(result.stderr, /Poster onboarding: clause 'protocol_fee_bps_is_number' failed\./u);
  assert.match(result.stderr, /observed: \{"protocolFeeBps":null,"availability":\{"protocolFeeBps":\{"status":"unavailable","reason":"live_chain_read_failed"\}/u);
  assert.match(result.stdout, /clause 'protocol_fee_bps_is_number' failed on a document whose live chain reads are unavailable \(protocolFeeBps=unavailable \(live_chain_read_failed\), feeRecipient=unavailable \(live_chain_read_failed\), claimBond=unavailable \(live_chain_read_failed\), disputeWindow=unavailable \(live_chain_read_failed\); snapshot asOf \d{4}-\d{2}-\d{2}T[0-9:.]+Z\)/u);
  assert.match(result.stdout, /so re-fetching ONCE in 0s\./u);
  assert.match(result.stdout, /poster onboarding clauses passed on the re-fetch; the live chain reads recovered \(snapshot asOf \d{4}-\d{2}-\d{2}T[0-9:.]+Z\)\./u);
  assert.match(result.stdout, /poster onboarding live reads available \(attempt 1\/1\)/u);
  assert.match(result.stdout, /Hosted stack smoke check passed\./u);
});

test("poster onboarding fails after the single re-fetch when live reads stay unavailable", async () => {
  // The backend caches the snapshot for POSTER_ONBOARDING_CACHE_MS; serving
  // the same asOf twice is exactly what a too-short wait looks like, and the
  // log must say so rather than let the operator believe the gateway was
  // observed twice.
  const cachedAsOf = "2026-09-12T20:00:00.000Z";
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    posterOnboardingResponses: [(poster) => coldGatewayPosterOnboarding(poster, cachedAsOf)]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.requestCounts["/poster/onboarding"], 2, "one re-fetch, never a loop");
  assert.match(result.stdout, /snapshot asOf 2026-09-12T20:00:00\.000Z\)\. The live-derived facts cannot be present until the chain gateway has warmed up/u);
  assert.match(result.stderr, /Poster onboarding \(re-fetch\): clause 'protocol_fee_bps_is_number' failed\./u);
  assert.match(result.stderr, /refused on clause 'protocol_fee_bps_is_number' after the single bounded re-fetch \(live reads: protocolFeeBps=unavailable \(live_chain_read_failed\)/u);
  assert.match(result.stderr, /Both reads carried the same snapshot \(asOf 2026-09-12T20:00:00\.000Z\)/u);
  assert.match(result.stderr, /TRANSIENT_RECHECK_SLEEP_SEC must stay at or above the backend's POSTER_ONBOARDING_CACHE_MS/u);
});

test("the operator-token lane walks admin status and the poster/policy cross-check green", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    operatorToken: "fixture-operator-token"
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Checking admin async XCM status/u);
  assert.equal(result.requestCounts["/admin/status"], 1, "/admin/status is fetched once and reused");
});

test("an admin-status clause failure names the clause and keeps the operator-facing message", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    operatorToken: "fixture-operator-token",
    adminStatus: {
      maintenance: { policy: { enabled: true, risk: { defaultClaimStakeBps: 100, claimFeeBps: 50 } } },
      xcmSettlementWatcher: { enabled: true, pendingCount: 0, running: false },
      xcmObservationRelay: { enabled: false, running: false, lastError: null, lastSyncedAt: null }
    }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /Admin status: clause 'xcm_settlement_watcher_running' failed\./u);
  assert.match(result.stderr, /observed: \{"enabled":true,"pendingCount":0,"running":false\}/u);
  assert.match(result.stderr, /settlement watcher loop is not alive/u);
});

test("the poster claim-bond policy cross-check names the drifted side", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    operatorToken: "fixture-operator-token",
    adminStatus: {
      maintenance: { policy: { enabled: true, risk: { defaultClaimStakeBps: 250, claimFeeBps: 50 } } },
      xcmSettlementWatcher: { enabled: true, pendingCount: 0, running: true },
      xcmObservationRelay: { enabled: false, running: false, lastError: null, lastSyncedAt: null }
    }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /Poster onboarding vs \/admin\/status: clause 'claim_bond_stake_bps_matches_policy' failed\./u);
  assert.match(result.stderr, /observed: \{"poster":100,"policy":250\}/u);
});

test("a clause that would have thrown inside jq is reported as that clause with the observed object", async () => {
  // A null onChain block made the old single expression throw on
  // `ascii_downcase` (jq exit 5, one stack line, no clause name). The clause
  // now evaluates to false and the log shows the object it read.
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    posterOnboardingResponses: [
      (poster) => ({ ...poster, cancellation: { ...poster.cancellation, onChain: null } })
    ]
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /Poster onboarding: clause 'cancellation_contract' failed\./u);
  assert.match(result.stderr, /observed: \{"cancellation":\{"selfServeCancel":true,"method":"cancelOpenJob\(bytes32\)","onChain":null/u);
});

test("hosted smoke owns HTML caching, canonical redirects, GET MCP, and the junk-receipt shell", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [] });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  for (const path of [
    "/agent-profile",
    "/reader-fetch.js?v=20260823",
    "/receipts/junk",
    "/site/onboarding",
    "/site/health",
    "/site/jobs/tiers",
    "/site/verify/profiles",
    "/redirect/app/transparency",
    "/redirect/app/transparency/",
    "/redirect/app/receipts/0xabc123def4567890abc123def4567890abc123de",
    "/redirect/app/jobs",
    "/redirect/app/jobs/example-job",
    "/redirect/site/work",
    "/redirect/site/work/example-job",
    "/site/get-started",
    "/app/post",
    "/app/poster/jobs",
    "/app/verify",
    "/app/withdraw",
    "/app/withdraw/",
    "/app/earnings",
    "/app/earnings/",
    "/api/jobs/open",
    "/mcp"
  ]) {
    assert.equal(result.requestCounts[path], 1, `${path} must be walked by the hosted smoke`);
  }
});

test("hosted smoke fails closed when HTML is not explicitly revalidated", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    htmlCacheControl: "public, max-age=300"
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /expected 'no-cache'/u);
  assert.equal(result.requestCounts["/"], 2, "body and header probes are separate assertions");
});

test("hosted smoke asserts the earnings account door is mounted and answers auth-first", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [] });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /earnings account door is mounted and wallet-scoped/u);
});

test("hosted smoke rejects an earnings door that serves account data without auth", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    accountUnauthenticatedOk: true
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /did not answer 401/u);
});

test("hosted smoke checks indexer sync liveness even when the indexer was not redeployed", async () => {
  // CHECK_INDEXER=0 is what a backend-only deploy passes; the 2026-09-10
  // wedge hid behind that skip for ~10h and surfaced only as the credit door
  // failing with an unrelated message.
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [] });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Checking indexer sync liveness/u);
  assert.match(result.stdout, /Indexer head is \d+s old \(budget 600s\)/u);
  assert.equal(result.requestCounts["/indexer/status"], 1);
  assert.equal(result.requestCounts["/"], 2, "the indexer deploy checks (root, ready) stay gated by CHECK_INDEXER");
});

test("hosted smoke fails closed on a stalled indexer sync before the credit door can misreport it", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    creditConfigured: true,
    indexerHeadAgeSec: 36_000,
    indexerHeadBlock: 20_501_734
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Indexer sync is stalled: newest indexed block 20501734 is 36\d{3}s old \(budget 600s\)/u);
  assert.match(result.stderr, /\/health stays 200/u);
  assert.match(result.stderr, /docker restart/u);
  assert.match(result.stderr, /INCIDENT_RESPONSE\.md/u);
  assert.equal(result.requestCounts["/credit"], undefined, "the stall must be named before the credit door runs");
});

test("hosted smoke honours INDEXER_MAX_STALENESS_SEC as the operator override for the sync budget", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    indexerHeadAgeSec: 120,
    extraEnv: { INDEXER_MAX_STALENESS_SEC: "1" }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /Indexer sync is stalled.*\(budget 1s\)/u);
});

test("hosted smoke can skip the sync liveness check only by explicit opt-out", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    indexerHeadAgeSec: 36_000,
    checkIndexerSync: "0"
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CHECK_INDEXER_SYNC=0 set; skipping indexer sync liveness check/u);
  assert.equal(result.requestCounts["/indexer/status"], undefined);
});

test("hosted smoke enforces CreditPool availability and the canonical disclosure after configuration", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [], creditConfigured: true });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Checking CreditPool door/u);
});

test("hosted smoke rejects an authenticated CreditPool 500", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    creditConfigured: true,
    creditStatus: 500,
    credit: {
      creditPool: `0x${"55".repeat(20)}`,
      error: "internal_error",
      message: "Do not know how to serialize a BigInt"
    }
  });
  assert.notEqual(result.code, 0, result.stdout);
});

test("hosted smoke requires all wallet debt fields from the authenticated CreditPool response", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    creditConfigured: true,
    credit: {
      available: true,
      chainId: 1,
      creditPool: `0x${"55".repeat(20)}`,
      wallet: { outstanding: { raw: "0", decimals: 6 } },
      receiptGraph: { wallet: { cash: { outstanding: { raw: "0", decimals: 6 } } } },
      disclosure: { statement: "Technical pilot. Principal at risk. No depositor protection." }
    }
  });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /L1\/L2\/L3 debt fields/u);
});

test("hosted smoke rejects a configured CreditPool with drifted disclosure", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    warnings: [],
    creditConfigured: true,
    credit: {
      available: true,
      chainId: 1,
      creditPool: `0x${"55".repeat(20)}`,
      wallet: { outstanding: { raw: "0", decimals: 6 } },
      receiptGraph: {
        wallet: {
          cash: { outstanding: { raw: "0", decimals: 6 } },
          posting: { outstanding: { raw: "0", decimals: 6 } }
        }
      },
      disclosure: { statement: "Principal probably safe." }
    }
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /exact depositor-risk disclosure/u);
});

test("hosted smoke rejects a 500 from the DepositPool door", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    poolStatus: 500,
    pool: {
      error: "internal_error",
      message: "DepositPool door requires a positive chainId."
    }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /DepositPool door returned HTTP 500; expected 200\./u);
});

test("hosted smoke rejects a 200 response when the DepositPool door is unavailable", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    pool: { available: false, reason: "deposit_pool_not_configured", chainId: 1 }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /DepositPool door did not report available: true\./u);
});

test("hosted smoke rejects a pool response without the exact depositor disclosure", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    pool: { available: true, chainId: 1 }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /did not carry the exact depositor-risk disclosure/u);
});

test("hosted smoke rejects any deposit-derived daily allowance field", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    pool: {
      available: true,
      chainId: 1,
      disclosure: { statement: "Technical pilot. Principal at risk. No depositor protection." },
      wallet: { dailyAllowance: { fromDeposits: { raw: "1", decimals: 6 } } }
    }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /still exposes a deposit-derived daily allowance field/u);
});

test("hosted smoke cross-checks poster onboarding against operational and chain-backed health", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(script, /API_POSTER_ONBOARDING_URL=/u);
  assert.match(script, /\.onboarding\.posterEntrypoint == "https:\/\/api\.averray\.com\/poster\/onboarding"/u);
  assert.match(script, /\.liveReads\.protocolFeeBps\.status == "available"/u);
  assert.match(script, /\.liveReads\.feeRecipient\.status == "available"/u);
  assert.match(script, /\.liveReads\.claimBond\.status == "available"/u);
  assert.match(script, /\.liveReads\.disputeWindow\.status == "available"/u);
  assert.match(script, /\.cancellation\.selfServeCancel == true/u);
  assert.match(script, /cancelOpenJob\(bytes32\)/u);
  assert.match(script, /\.cancellation\.minimumOpenSeconds == 3600/u);
  assert.match(script, /operator-mediated on request, ~7 days, refunds only ever to the recorded poster/u);
  assert.match(script, /cancelOpenJob, next EscrowCore deployment window/u);
  assert.match(script, /\$poster\.chainId == \$health\.auth\.chainId/u);
  assert.match(script, /\$poster\.escrowCore \| ascii_downcase/u);
  assert.match(script, /\.economics\.feeRecipient \| ascii_downcase/u);
  assert.match(script, /function openDispute\(bytes32 jobId\)/u);
  assert.match(script, /no_worker_reachable_brokered_open_dispute_route/u);
  assert.match(script, /function approve\(address spender, uint256 amount\) returns \(bool\)/u);
  assert.match(script, /function deposit\(address asset, uint256 amount\)/u);
  assert.match(script, /max\(posterReservedRaw - positions\(poster, token\)\.liquid, 0\)/u);
  assert.match(script, /max\(floor\(rewardRaw \* economics\.posterFeeBps \/ 10000\), economics\.posterFeeFloorRaw\)/u);
  assert.match(script, /\$poster\.workerFacts\.claimBond\.stakeBps == \$operational\.maintenance\.policy\.risk\.defaultClaimStakeBps/u);
  assert.match(script, /\$poster\.workerFacts\.claimBond\.feeBps == \$operational\.maintenance\.policy\.risk\.claimFeeBps/u);
});

test("docker product-proof gate can read hosted worker-loop evidence", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /PRODUCT_PROOF_EVIDENCE_FILE="\$repo_root\/\$PRODUCT_PROOF_EVIDENCE_FILE"/u,
    "relative evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /product_proof_evidence_dir="\$\(dirname "\$PRODUCT_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the host evidence directory"
  );
  assert.match(
    script,
    /mkdir -p "\$product_proof_evidence_dir"/u,
    "docker fallback should create the host evidence directory"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args=\(-v "\$repo_root:\/workspace"\)/u,
    "docker fallback should keep mounting the repository"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args\+=\(-v "\$product_proof_evidence_dir:\$product_proof_evidence_dir"\)/u,
    "docker fallback should mount the evidence directory at the same absolute path"
  );
  assert.match(
    script,
    /"\$\{product_proof_docker_volume_args\[@\]\}"/u,
    "docker fallback should pass the dynamic volume list to docker run"
  );
});

test("operator reporting gate keeps email optional and guards secrets", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_FROM=/u,
    "optional email smoke should support an explicit expected sender check"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_TO=/u,
    "optional email smoke should support an explicit expected recipient check"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured \| type\) == "boolean"/u,
    "operator reporting instrumentation should expose optional email provider state"
  );
  assert.match(
    script,
    /\.upstreamStatus\.fundedJobs\.totalRecords \| type\) == "number"/u,
    "operator reporting instrumentation should expose bounded funded-job table counters"
  );
  assert.match(
    script,
    /\.upstreamStatus\.evidencePersistenceNote \| type\) == "string"/u,
    "upstream status evidence should say whether service state is durable"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.to \| type\) == "array"/u,
    "operator reporting instrumentation should expose a concrete recipient list"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured == false or/u,
    "base operator reporting smoke should not require a paid or verified email provider"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.recipientCount == \(\.bootstrapSelfReport\.to \| length\)/u,
    "recipientCount should agree with the visible recipient list when email is configured"
  );
  assert.ok(
    script.includes('test("Bearer\\\\s+[^\\\\s,}\\\\]]+|re_[A-Za-z0-9_-]{12,}"; "i")'),
    "bootstrap status should be scanned for API-key-shaped tokens"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastAttemptedAt \| type\) == "string"/u,
    "sent gate should require lastAttemptedAt"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastSuccessfulAt \| type\) == "string"/u,
    "sent gate should require lastSuccessfulAt"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC/u,
    "optional sent-email gate should bound the freshness of lastSuccessfulAt"
  );
});

test("scoped service-token proof gate is opt-in, admin-gated, and supports evidence files", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=\$\{CHECK_SERVICE_TOKEN_PROOF:-0\}/u,
    "service-token proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=1 requires ADMIN_JWT/u,
    "service-token proof should fail closed without an admin token"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_EVIDENCE_FILE="\$repo_root\/\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"/u,
    "relative service-token evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /service_token_proof_evidence_dir="\$\(dirname "\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the service-token evidence host directory"
  );
  assert.match(
    script,
    /mkdir -p "\$service_token_proof_evidence_dir"/u,
    "docker fallback should create the service-token evidence host directory"
  );
  assert.match(
    script,
    /node "\$script_dir\/check-service-token-proof\.mjs"/u,
    "node path should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /node scripts\/ops\/check-service-token-proof\.mjs/u,
    "docker fallback should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_CAPABILITIES="\$SERVICE_TOKEN_PROOF_CAPABILITIES"/u,
    "service-token proof should pass capability overrides through"
  );
  assert.match(
    script,
    /service_token_proof_docker_volume_args\+=\(-v "\$service_token_proof_evidence_dir:\$service_token_proof_evidence_dir"\)/u,
    "docker fallback should mount service-token evidence at the same absolute path"
  );
});

test("external schema proof gate is opt-in, admin-gated, and supports evidence files", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_EXTERNAL_SCHEMA_PROOF=\$\{CHECK_EXTERNAL_SCHEMA_PROOF:-0\}/u,
    "external-schema proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_EXTERNAL_SCHEMA_PROOF=1 requires ADMIN_JWT/u,
    "external-schema proof should fail closed without an admin token"
  );
  assert.match(
    script,
    /EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE="\$repo_root\/\$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE"/u,
    "relative external-schema evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /external_schema_proof_evidence_dir="\$\(dirname "\$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the external-schema evidence host directory"
  );
  assert.match(
    script,
    /mkdir -p "\$external_schema_proof_evidence_dir"/u,
    "docker fallback should create the external-schema evidence host directory"
  );
  assert.match(
    script,
    /node "\$script_dir\/check-external-schema-registration-proof\.mjs"/u,
    "node path should invoke the external-schema proof checker"
  );
  assert.match(
    script,
    /node scripts\/ops\/check-external-schema-registration-proof\.mjs/u,
    "docker fallback should invoke the external-schema proof checker"
  );
  assert.match(
    script,
    /EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY="\$EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY"/u,
    "external-schema proof should pass idempotency override through"
  );
  assert.match(
    script,
    /external_schema_proof_docker_volume_args\+=\(-v "\$external_schema_proof_evidence_dir:\$external_schema_proof_evidence_dir"\)/u,
    "docker fallback should mount external-schema evidence at the same absolute path"
  );
});

test("metrics auth gate is opt-in and verifies both denied and allowed scrapes", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_METRICS_AUTH=\$\{CHECK_METRICS_AUTH:-0\}/u,
    "metrics auth proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_METRICS_AUTH=1 requires METRICS_BEARER_TOKEN/u,
    "metrics auth proof should fail closed without the scraper token"
  );
  assert.match(
    script,
    /Expected unauthenticated \/metrics to return 401/u,
    "metrics auth proof should require no-bearer requests to be denied"
  );
  assert.match(
    script,
    /authorization: Bearer \$METRICS_BEARER_TOKEN/u,
    "metrics auth proof should send the scraper bearer token"
  );
  assert.match(
    script,
    /Expected bearer-authenticated \/metrics to return 200/u,
    "metrics auth proof should require bearer-authenticated scrapes to work"
  );
});

test("dispute verdict proof gate is opt-in, live-only, and requires chain dispatch", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=\$\{CHECK_DISPUTE_VERDICT_PROOF:-0\}/u,
    "dispute verdict proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=1 requires ADMIN_JWT or AVERRAY_TOKEN/u,
    "dispute verdict proof should fail closed without an authenticated operator token"
  );
  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=1 requires DISPUTE_PROOF_LIVE=1/u,
    "hosted proof should not accept dry-run output as launch evidence"
  );
  assert.match(
    script,
    /DISPUTE_PROOF_REQUIRE_CHAIN=1/u,
    "hosted proof should require confirmed/submitted chain dispatch, not local_only receipts"
  );
  assert.match(
    script,
    /DISPUTE_PROOF_JSON_ONLY=1/u,
    "hosted proof should request machine-readable JSON without progress logs"
  );
  assert.match(
    script,
    /run-dispute-verdict-proof\.mjs/u,
    "hosted proof should invoke the dispute verdict proof harness"
  );
  assert.match(
    script,
    /\.response\.chainStatus == "confirmed" or \.response\.chainStatus == "submitted"/u,
    "hosted proof should only accept confirmed or submitted chain status"
  );
  assert.match(
    script,
    /\.persisted\.reasoningHash == \.response\.reasoningHash/u,
    "hosted proof should assert persistence matches the verdict response"
  );
});

test("admin async XCM smoke verifies the watcher lane is publishing, not just configured", async () => {
  // Structural lock-in for the PROJECT_ROADMAP.md P0 row "Hosted
  // /admin/status async XCM smoke" — the close criterion is "Run
  // hosted check with live admin JWT and verify async XCM watcher
  // lane". Before this PR the smoke asserted only .enabled == true on
  // the watcher; that proves the watcher was wired in at backend
  // construction, not that the polling loop is alive. The new
  // assertion adds .running == true.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /OPERATOR_TOKEN=\$\{AVERRAY_TOKEN:-\$ADMIN_JWT\}/u,
    "short-lived AVERRAY_TOKEN must take precedence over the legacy ADMIN_JWT."
  );
  assert.match(
    script,
    /authorization: Bearer \$OPERATOR_TOKEN/u,
    "the admin-status gate must accept the selected short-lived operator token."
  );
  assert.match(
    script,
    /if \[\[ -n "\$OPERATOR_TOKEN" \]\]; then\s+echo "Checking admin async XCM status"/u,
    "admin async XCM checks must run for either refresh-minted or legacy operator auth."
  );
  assert.match(
    script,
    /\.xcmSettlementWatcher\.running == true/u,
    "admin async XCM smoke must assert .xcmSettlementWatcher.running == true so a watcher whose start() never ran fails the deploy."
  );
  assert.match(
    script,
    /settlement watcher loop is not alive/u,
    "smoke must surface a clear operator-facing error when .running is false."
  );
});

test("admin async XCM smoke gates xcmObservationRelay on running + no lastError when enabled", async () => {
  // The observation relay is the upstream observer-feed poll loop. A
  // sticky lastError indicates the backend can't reach the observer
  // feed and async XCM settlement is silently degraded. Smoke must
  // catch this before the operator does.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  // The conditional shape: either disabled, or (running AND empty
  // lastError). Disabled means the deploy intentionally didn't wire
  // the relay — that's not a smoke failure.
  assert.match(
    script,
    /\.xcmObservationRelay\.enabled == false or\s*\([\s\S]{0,200}\.xcmObservationRelay\.running == true and\s*\([\s\S]{0,200}\.xcmObservationRelay\.lastError == null or \(\.xcmObservationRelay\.lastError \| tostring \| length\) == 0/u,
    "xcmObservationRelay assertion must be (disabled OR (running AND empty lastError))."
  );
  assert.match(
    script,
    /upstream observer feed broken/u,
    "smoke must surface a clear operator-facing error when the relay is enabled but lastError is non-empty."
  );
});

test("admin async XCM smoke has an optional freshness gate on xcmObservationRelay.lastSyncedAt", async () => {
  // Freshness gate proves the relay is polling at the expected
  // cadence — a relay that's "running: true" but whose loop has
  // stalled would otherwise pass the previous assertion. Gate is
  // off when relay is disabled or lastSyncedAt is null (freshly
  // restarted, hasn't polled yet). Default 1800s (30 min) — 2× a
  // 15-min poll interval gives headroom; tunable via
  // XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800/u,
    "freshness gate must have a default staleness budget (1800s) and be tunable via XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC."
  );
  assert.match(
    script,
    /\.xcmObservationRelay\.lastSyncedAt == null/u,
    "freshness gate must skip when lastSyncedAt is null (relay never polled yet — not a failure)."
  );
  assert.match(
    script,
    /relay is not polling at the expected cadence/u,
    "freshness gate must surface a clear operator-facing error when the cadence has stalled."
  );
});

// The four liveReads clauses assert a third-party RPC answered, not that
// anything of ours is correct. They failed two production deploys on
// 2026-08-08 while the code had already installed successfully, so they are
// retried and then advisory.
//
// The test above matches those clause strings and would pass whether they are
// hard-gated or advisory, so it never protected this. Pin the semantics.
test("live chain reads are retried and advisory, never a hard deploy gate", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(script, /LIVE_READ_ATTEMPTS="\$\{LIVE_READ_ATTEMPTS:-\d+\}"/u);
  assert.match(script, /live_reads_available\(\)/u);
  assert.match(script, /advisory only/u);

  // The retry must re-fetch. A payload already in hand cannot recover, so a
  // loop that only re-tests the same JSON would sleep and fail regardless.
  const loop = script.slice(script.indexOf("live_read_attempt=1"));
  assert.match(loop, /poster_onboarding_json="\$\(fetch "\$API_POSTER_ONBOARDING_URL"\)"/u);

  // The clauses must NOT sit inside the hard structural assertion any more.
  const structural = script.slice(
    script.indexOf("Checking poster onboarding live facts"),
    script.indexOf("live_reads_available()")
  );
  assert.doesNotMatch(structural, /\.liveReads\./u);
});

// `.liveReads` carries a scalar `asOf` beside the read objects. Without the
// type guard the failure dump prints a jq error instead of naming the read
// that failed — hidden behind `|| true`, so nothing would catch it.
test("the advisory dump names the failing read rather than erroring", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");
  assert.match(script, /select\(\.value \| type == "object"\)/u);
});

// Every jq assertion goes through evaluate_clauses so a red run names its
// clause. A bare `jq -e '...' >/dev/null <<<"$something_json"` fails a deploy
// with "exit code 1" and nothing else — the shape behind the 2026-09-11/12
// production failures. The only `jq -e` calls left at statement start are the
// predicate helpers that read their own `$1`, and the one `if jq -e` gate.
test("no bare jq -e assertion is fed a document outside evaluate_clauses", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");
  const bare = [...script.matchAll(/^\s*jq -e [\s\S]*?<<<"([^"]+)"/gmu)];
  assert.ok(bare.length >= 3, "the predicate helpers still use jq -e on their argument");
  for (const match of bare) {
    assert.equal(match[1], "$1", `bare jq -e must only appear in a helper reading $1, found one reading ${match[1]}:\n${match[0].slice(0, 200)}`);
  }
  assert.doesNotMatch(script, /\| jq -e -s/u, "cross-document checks go through evaluate_clauses -s");
  assert.match(script, /^assert_clauses\(\) \{\n  evaluate_clauses "\$@" \|\| exit 1\n\}/mu);
});

// The two re-read sites and their guard rails. The verifier re-read is keyed
// on the streak age, not on the warning being present; indexer_stalled is
// excluded by name so it can never ride along.
test("deploy-time re-reads are single, bounded, and never cover indexer_stalled", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(script, /TRANSIENT_RECHECK_SLEEP_SEC=\$\{TRANSIENT_RECHECK_SLEEP_SEC:-30\}/u);
  assert.match(script, /TRANSIENT_RECHECK_MAX_SLEEP_SEC=\$\{TRANSIENT_RECHECK_MAX_SLEEP_SEC:-90\}/u);
  assert.match(script, /VERIFIER_CRITICAL_GRACE_SEC=\$\{VERIFIER_CRITICAL_GRACE_SEC:-600\}/u);

  const transientGuard = script.slice(
    script.indexOf("health_transient_verifier_critical() {"),
    script.indexOf("health_recheck_delay_sec() {")
  );
  assert.match(transientGuard, /select\(\.code == "indexer_stalled"\)\] \| length == 0/u);
  assert.match(transientGuard, /\$v\.state == "submitted_session_persistently_skipped"/u);
  assert.match(transientGuard, /\(\(\$runs \| max\) \* \$v\.intervalMs \/ 1000\) <= \$graceSec/u);

  // indexer_not_stalled is a hard API-health clause, ordered before the
  // verifier clause so it is the one named when both are red.
  const healthClauses = script.slice(
    script.indexOf("api_health_clauses=("),
    script.indexOf("api_health_json=\"$(fetch \"$API_HEALTH_URL\")\"")
  );
  assert.ok(
    healthClauses.indexOf("indexer_not_stalled") < healthClauses.indexOf("auto_verifier_ok"),
    "indexer_not_stalled must be evaluated before auto_verifier_ok"
  );

  // Each site re-reads exactly once: one sleep, one fetch, one re-evaluation,
  // then exit 1 — no loop construct around either.
  for (const [start, end] of [
    ['echo "Checking API health"', "# Before any door that answers from the index"],
    ['echo "Checking poster onboarding live facts"', "# Live chain reads are RETRIED, then advisory."]
  ]) {
    const site = script.slice(script.indexOf(start), script.indexOf(end));
    assert.equal((site.match(/^\s*sleep /gmu) ?? []).length, 1, `${start} sleeps exactly once`);
    assert.doesNotMatch(site, /^\s*(while|until|for)\b/mu, `${start} has no retry loop`);
  }
});
