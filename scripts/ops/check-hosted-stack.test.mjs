import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts/ops/check-hosted-stack.sh");

const ADDRESSES = {
  escrowCore: `0x${"11".repeat(20)}`,
  agentAccountCore: `0x${"22".repeat(20)}`,
  token: `0x${"33".repeat(20)}`,
  feeRecipient: `0x${"44".repeat(20)}`
};

async function runHostedStackFixture({
  autoVerifierOk,
  warnings = [],
  poolStatus = 200,
  pool = {
    available: true,
    chainId: 1,
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
  const onboarding = {
    name: "Averray fixture",
    protocols: ["http"],
    externalBounties: {
      posterOnboarding: "/poster/onboarding",
      cancellation: {
        selfServeCancel: false,
        rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
        plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
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
      feeRecipient: ADDRESSES.feeRecipient,
      minRewardUsdc: "1",
      draftTtlHours: 24,
      quotePersistence: "demand_signal_only_until_funded",
      quoteIdentity: "poster_and_content_hash"
    },
    cancellation: {
      selfServeCancel: false,
      rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
      plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
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
      posterReservedRawFormula: "rewardRaw + opsReserveRaw + contingencyReserveRaw + floor(rewardRaw * economics.protocolFeeBps / 10000)",
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
      protocolFeeBps: { status: "available" },
      feeRecipient: { status: "available" },
      claimBond: { status: "available" },
      disputeWindow: { status: "available" }
    }
  };

  const fixtures = new Map([
    ["/", "<html><head><title>Averray fixture</title></head></html>"],
    ["/app", "Opening the operator control room."],
    ["/.well-known/agent-tools.json", {
      discoveryUrl: "https://averray.com/.well-known/agent-tools.json",
      baseUrl: "https://api.averray.com",
      publicEndpoints: [{ path: "/poster/onboarding" }],
      onboarding: { posterEntrypoint: "https://api.averray.com/poster/onboarding" }
    }],
    ["/health", health],
    ["/onboarding", onboarding],
    ["/poster/onboarding", posterOnboarding]
  ]);
  const server = createServer((request, response) => {
    if (request.url === "/pool") {
      response.writeHead(poolStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(pool));
      return;
    }
    const value = fixtures.get(request.url);
    if (value === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": typeof value === "string" ? "text/html" : "application/json"
    });
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
      DISCOVERY_URL: `${baseUrl}/.well-known/agent-tools.json`,
      APP_URL: `${baseUrl}/app`,
      API_HEALTH_URL: `${baseUrl}/health`,
      API_POOL_URL: `${baseUrl}/pool`,
      API_ONBOARDING_URL: `${baseUrl}/onboarding`,
      API_POSTER_ONBOARDING_URL: `${baseUrl}/poster/onboarding`,
      ADMIN_JWT: "",
      AVERRAY_TOKEN: "",
      CHECK_INDEXER: "0",
      CHECK_BOOTSTRAP_INSTRUMENTATION: "0",
      CHECK_BOOTSTRAP_SELF_REPORT_SENT: "0",
      CHECK_PRODUCT_PROOF_GATE: "0",
      CHECK_SERVICE_TOKEN_PROOF: "0",
      CHECK_EXTERNAL_SCHEMA_PROOF: "0",
      CHECK_DISPUTE_VERDICT_PROOF: "0",
      CHECK_SIWE_FRESH_WALLET_PROOF: "0",
      CHECK_WORKER_CANARY_PROOF: "0",
      CHECK_METRICS_AUTH: "0",
      PRODUCT_HEALTH_EXPECTED_WARNINGS: "submitted_session_persistently_skipped",
      LIVE_READ_ATTEMPTS: "1",
      TIMEOUT_SEC: "5"
    };

    return await new Promise((resolve, reject) => {
      const child = spawn("bash", [CHECK_SCRIPT], { cwd: REPO_ROOT, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("hosted smoke rejects an unhealthy submitted-job verifier even with no warnings", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: false, warnings: [] });

  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(result.signal, null);
});

test("hosted smoke accepts a healthy submitted-job verifier", async () => {
  const result = await runHostedStackFixture({ autoVerifierOk: true, warnings: [] });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Checking DepositPool door/u);
  assert.match(result.stdout, /Hosted stack smoke check passed\./u);
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

test("hosted smoke rejects an available DepositPool door without the depositor disclosure", async () => {
  const result = await runHostedStackFixture({
    autoVerifierOk: true,
    pool: { available: true, chainId: 1 }
  });

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /required depositor risk disclosure/u);
});

test("hosted smoke cross-checks poster onboarding against operational and chain-backed health", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(script, /API_POSTER_ONBOARDING_URL=/u);
  assert.match(script, /\.onboarding\.posterEntrypoint == "https:\/\/api\.averray\.com\/poster\/onboarding"/u);
  assert.match(script, /\.liveReads\.protocolFeeBps\.status == "available"/u);
  assert.match(script, /\.liveReads\.feeRecipient\.status == "available"/u);
  assert.match(script, /\.liveReads\.claimBond\.status == "available"/u);
  assert.match(script, /\.liveReads\.disputeWindow\.status == "available"/u);
  assert.match(script, /\.cancellation\.selfServeCancel == false/u);
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
