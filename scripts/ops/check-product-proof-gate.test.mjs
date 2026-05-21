import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildDiscoveryManifest } from "../../mcp-server/src/core/discovery-manifest.js";
import { listBuiltinJobSchemas } from "../../mcp-server/src/core/job-schema-registry.js";
import { checkProductProofGate } from "./check-product-proof-gate.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/deploy-production.yml");

test("checkProductProofGate validates public discovery, pages, and schemas", async () => {
  const manifest = buildDiscoveryManifest();
  const responses = new Map([
    ["https://averray.com/.well-known/agent-tools.json", manifest],
    ["https://api.averray.com/agent-tools.json", manifest],
    ["https://api.averray.com/onboarding", {
      name: manifest.name,
      discoveryUrl: manifest.discoveryUrl,
      discoveryMode: manifest.discoveryMode,
      protocols: manifest.protocols,
      onboarding: { starterFlow: manifest.onboarding.starterFlow },
      auth: { schemeId: manifest.auth.schemeId },
      tools: manifest.tools.map((tool) => tool.name)
    }],
    ["https://averray.com/trust/", "Averray — Trust Open discovery manifest https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/", "Averray — Schemas agent-badge-v1.json agent-profile-v1.json"],
    ["https://averray.com/agents/", "Averray — For agents Read /.well-known/agent-tools.json https://api.averray.com/onboarding"],
    ["https://averray.com/builders/", "Averray — Builders https://api.averray.com/schemas/jobs"],
    ["https://averray.com/llms.txt", "Discovery manifest: https://averray.com/.well-known/agent-tools.json\nOnboarding: https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/agent-badge-v1.json", {
      $id: "https://averray.com/schemas/agent-badge-v1.json"
    }],
    ["https://averray.com/schemas/agent-profile-v1.json", {
      $id: "https://averray.com/schemas/agent-profile-v1.json"
    }],
    ["https://api.averray.com/schemas/jobs", {
      ...jobSchemaIndex()
    }],
    ["https://api.averray.com/schemas/jobs/wikipedia-citation-repair-output.json", {
      $id: "schema://jobs/wikipedia-citation-repair-output"
    }]
  ]);

  const seen = [];
  await checkProductProofGate({
    env: { PRODUCT_PROOF_EVIDENCE_FILE: "/tmp/product-proof-evidence-not-required.json" },
    fetchImpl: fakeFetch(responses),
    log: (line) => seen.push(line)
  });

  assert.ok(seen.includes("Product-proof gate passed."));
  assert.ok(seen.includes("Worker-loop evidence is not required; skipping mutation-loop evidence check."));
});

test("checkProductProofGate fails when the public manifest drifts from the API mirror", async () => {
  const manifest = buildDiscoveryManifest();
  const drifted = {
    ...manifest,
    version: "stale"
  };
  const responses = new Map([
    ["https://averray.com/.well-known/agent-tools.json", drifted],
    ["https://api.averray.com/agent-tools.json", manifest]
  ]);

  await assert.rejects(
    () => checkProductProofGate({ fetchImpl: fakeFetch(responses), log: () => {} }),
    /public discovery manifest must match the API mirror/u
  );
});

test("checkProductProofGate requires an evidence file when the worker loop is mandatory", async () => {
  const manifest = buildDiscoveryManifest();
  const responses = new Map([
    ["https://averray.com/.well-known/agent-tools.json", manifest],
    ["https://api.averray.com/agent-tools.json", manifest],
    ["https://api.averray.com/onboarding", {
      name: manifest.name,
      discoveryUrl: manifest.discoveryUrl,
      discoveryMode: manifest.discoveryMode,
      protocols: manifest.protocols,
      onboarding: { starterFlow: manifest.onboarding.starterFlow },
      auth: { schemeId: manifest.auth.schemeId },
      tools: manifest.tools.map((tool) => tool.name)
    }],
    ["https://averray.com/trust/", "Averray — Trust Open discovery manifest https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/", "Averray — Schemas agent-badge-v1.json agent-profile-v1.json"],
    ["https://averray.com/agents/", "Averray — For agents Read /.well-known/agent-tools.json https://api.averray.com/onboarding"],
    ["https://averray.com/builders/", "Averray — Builders https://api.averray.com/schemas/jobs"],
    ["https://averray.com/llms.txt", "Discovery manifest: https://averray.com/.well-known/agent-tools.json\nOnboarding: https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/agent-badge-v1.json", {
      $id: "https://averray.com/schemas/agent-badge-v1.json"
    }],
    ["https://averray.com/schemas/agent-profile-v1.json", {
      $id: "https://averray.com/schemas/agent-profile-v1.json"
    }],
    ["https://api.averray.com/schemas/jobs", {
      ...jobSchemaIndex()
    }],
    ["https://api.averray.com/schemas/jobs/wikipedia-citation-repair-output.json", {
      $id: "schema://jobs/wikipedia-citation-repair-output"
    }]
  ]);

  await assert.rejects(
    () => checkProductProofGate({
      env: { PRODUCT_PROOF_REQUIRE_WORKER_LOOP: "1" },
      fetchImpl: fakeFetch(responses),
      log: () => {}
    }),
    /PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 requires PRODUCT_PROOF_EVIDENCE_FILE/u
  );
});

test("checkProductProofGate validates required hosted worker-loop evidence", async () => {
  const manifest = buildDiscoveryManifest();
  const wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
  const sessionId = "session-product-proof";
  const jobId = "product-proof-worker-loop-1700000000000";
  const evidence = workerLoopEvidence({ wallet, sessionId, jobId });
  const tmp = await mkdtemp(join(tmpdir(), "product-proof-gate-"));
  const evidenceFile = join(tmp, "evidence.json");
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  const responses = productProofResponses(manifest);
  responses.set(`https://api.averray.com/badges/${sessionId}`, {
    averray: {
      schemaVersion: "v1",
      sessionId,
      jobId,
      worker: wallet
    }
  });
  responses.set(`https://api.averray.com/agents/${wallet}`, {
    schemaVersion: "v1",
    wallet,
    badges: [{ sessionId, jobId }]
  });

  await checkProductProofGate({
    env: {
      PRODUCT_PROOF_REQUIRE_WORKER_LOOP: "1",
      PRODUCT_PROOF_EVIDENCE_FILE: evidenceFile
    },
    fetchImpl: fakeFetch(responses),
    log: () => {}
  });
});

test("checkProductProofGate rejects minimal evidence when worker-loop proof is required", async () => {
  const manifest = buildDiscoveryManifest();
  const tmp = await mkdtemp(join(tmpdir(), "product-proof-gate-"));
  const evidenceFile = join(tmp, "evidence.json");
  await writeFile(evidenceFile, JSON.stringify({
    sessionId: "session-product-proof",
    jobId: "product-proof-worker-loop-1700000000000",
    wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519"
  }));

  await assert.rejects(
    () => checkProductProofGate({
      env: {
        PRODUCT_PROOF_REQUIRE_WORKER_LOOP: "1",
        PRODUCT_PROOF_EVIDENCE_FILE: evidenceFile
      },
      fetchImpl: fakeFetch(productProofResponses(manifest)),
      log: () => {}
    }),
    /worker-loop evidence requires approved verificationOutcome/u
  );
});

test("checkProductProofGate rejects worker-loop evidence without invalid schema proof", async () => {
  const manifest = buildDiscoveryManifest();
  const tmp = await mkdtemp(join(tmpdir(), "product-proof-gate-"));
  const evidenceFile = join(tmp, "evidence.json");
  const evidence = workerLoopEvidence({
    wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    sessionId: "session-product-proof",
    jobId: "product-proof-worker-loop-1700000000000"
  });
  delete evidence.invalidValidationReadiness;
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  await assert.rejects(
    () => checkProductProofGate({
      env: {
        PRODUCT_PROOF_REQUIRE_WORKER_LOOP: "1",
        PRODUCT_PROOF_EVIDENCE_FILE: evidenceFile
      },
      fetchImpl: fakeFetch(productProofResponses(manifest)),
      log: () => {}
    }),
    /worker-loop evidence requires an invalid schema validation proof/u
  );
});

test("checkProductProofGate rejects worker-loop evidence with a plain verifier evidence override", async () => {
  const manifest = buildDiscoveryManifest();
  const tmp = await mkdtemp(join(tmpdir(), "product-proof-gate-"));
  const evidenceFile = join(tmp, "evidence.json");
  const evidence = workerLoopEvidence({
    wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    sessionId: "session-product-proof",
    jobId: "product-proof-worker-loop-1700000000000"
  });
  evidence.verificationReadiness = {
    ...evidence.verificationReadiness,
    usesStoredSessionSubmission: false,
    evidenceOverrideProvided: true
  };
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  await assert.rejects(
    () => checkProductProofGate({
      env: {
        PRODUCT_PROOF_REQUIRE_WORKER_LOOP: "1",
        PRODUCT_PROOF_EVIDENCE_FILE: evidenceFile
      },
      fetchImpl: fakeFetch(productProofResponses(manifest)),
      log: () => {}
    }),
    /worker-loop evidence verifier must use the stored structured session submission/u
  );
});

function fakeFetch(responses) {
  return async (url) => {
    const value = responses.get(String(url));
    if (value === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => "not found"
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => typeof value === "string" ? value : JSON.stringify(value)
    };
  };
}

function productProofResponses(manifest) {
  return new Map([
    ["https://averray.com/.well-known/agent-tools.json", manifest],
    ["https://api.averray.com/agent-tools.json", manifest],
    ["https://api.averray.com/onboarding", {
      name: manifest.name,
      discoveryUrl: manifest.discoveryUrl,
      discoveryMode: manifest.discoveryMode,
      protocols: manifest.protocols,
      onboarding: { starterFlow: manifest.onboarding.starterFlow },
      auth: { schemeId: manifest.auth.schemeId },
      tools: manifest.tools.map((tool) => tool.name)
    }],
    ["https://averray.com/trust/", "Averray — Trust Open discovery manifest https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/", "Averray — Schemas agent-badge-v1.json agent-profile-v1.json"],
    ["https://averray.com/agents/", "Averray — For agents Read /.well-known/agent-tools.json https://api.averray.com/onboarding"],
    ["https://averray.com/builders/", "Averray — Builders https://api.averray.com/schemas/jobs"],
    ["https://averray.com/llms.txt", "Discovery manifest: https://averray.com/.well-known/agent-tools.json\nOnboarding: https://api.averray.com/onboarding"],
    ["https://averray.com/schemas/agent-badge-v1.json", {
      $id: "https://averray.com/schemas/agent-badge-v1.json"
    }],
    ["https://averray.com/schemas/agent-profile-v1.json", {
      $id: "https://averray.com/schemas/agent-profile-v1.json"
    }],
    ["https://api.averray.com/schemas/jobs", {
      ...jobSchemaIndex()
    }],
    ["https://api.averray.com/schemas/jobs/wikipedia-citation-repair-output.json", {
      $id: "schema://jobs/wikipedia-citation-repair-output"
    }]
  ]);
}

function jobSchemaIndex() {
  const schemas = listBuiltinJobSchemas().map(({ $id }) => ({ $id }));
  return {
    count: schemas.length,
    schemas
  };
}

function workerLoopEvidence({ wallet, sessionId, jobId }) {
  return {
    apiBaseUrl: "https://api.averray.com",
    wallet,
    jobId,
    sessionId,
    verificationOutcome: "approved",
    verificationReasonCode: "BENCHMARK_THRESHOLD_MET",
    settlementReadiness: {
      settlementReady: true,
      asset: {
        symbol: "USDC",
        address: "0x0000053900000000000000000000000001200000",
        assetClass: "trust_backed",
        assetId: 1337,
        decimals: 6,
        minBalanceRaw: "70000",
        approved: true
      },
      roles: {
        signerAddress: wallet,
        signerIsVerifier: true,
        escrowIsServiceOperator: true,
        agentAccountIsServiceOperator: true
      }
    },
    rewardReadiness: {
      asset: "USDC",
      rewardRaw: "100000",
      minBalanceRaw: "70000"
    },
    signerFundingReadiness: {
      signer: wallet,
      asset: "USDC",
      rewardRaw: "100000",
      totalClaimLockRaw: "0",
      requiredRaw: "100000",
      availableRaw: "155000"
    },
    liquidityReadiness: {
      wallet,
      asset: "USDC",
      requiredRaw: "100000",
      availableRaw: "155000"
    },
    claimLiquidityReadiness: {
      wallet,
      asset: "USDC",
      rewardRaw: "100000",
      totalClaimLockRaw: "55000",
      requiredRaw: "155000",
      availableRaw: "155000"
    },
    claimSignerFundingReadiness: {
      signer: wallet,
      asset: "USDC",
      rewardRaw: "100000",
      totalClaimLockRaw: "55000",
      requiredRaw: "155000",
      availableRaw: "155000"
    },
    preflightReadiness: {
      wallet,
      jobId,
      eligible: true,
      claimable: true,
      currentWalletCanClaim: true,
      requiredOutputSchema: "schema://jobs/product-proof-worker-loop"
    },
    validationReadiness: {
      jobId,
      valid: true,
      schemaRef: "schema://jobs/product-proof-worker-loop",
      schemaValidates: "payload.submission",
      submissionKind: "structured",
      validatedBeforeClaim: true
    },
    invalidValidationReadiness: {
      jobId,
      valid: false,
      submitSafe: false,
      schemaRef: "schema://jobs/product-proof-worker-loop",
      schemaValidates: "payload.submission",
      code: "invalid_submission_shape",
      message: "Send the structured proposal object directly as submission, not under submission.output.",
      path: "payload.submission.output",
      received: "payload.submission.output",
      hint: "Move the object currently under submission.output up to submission.",
      checkedBeforeClaim: true,
      submitAttempted: false
    },
    verificationReadiness: {
      schemaRef: "schema://jobs/product-proof-worker-loop",
      usesStoredSessionSubmission: true,
      evidenceOverrideProvided: false
    },
    claimReadiness: {
      status: "claimed",
      sessionId
    },
    submitStatus: "submitted",
    sessionStatus: "resolved",
    completedAt: "2026-05-13T11:11:31.000Z"
  };
}

test("deploy-production workflow defaults the product-proof gate to run on every deploy", async () => {
  // Structural lock-in for the PROJECT_ROADMAP.md P0 gates "Public
  // discovery/schema/trust gate" and "Canonical public discovery/API
  // mirror" — both close by having the product-proof gate run on
  // every deploy (not opt-in only). The fallback value in the
  // DEPLOY_SMOKE_CHECK_PRODUCT_PROOF_GATE env expression IS the gate
  // — if it goes back to '0', auto-deploys (workflow_run) stop
  // running the gate and the P0 reopens silently.
  const yaml = await readFile(WORKFLOW_PATH, "utf8");

  assert.match(
    yaml,
    /DEPLOY_SMOKE_CHECK_PRODUCT_PROOF_GATE:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.smoke_check_product_proof_gate\s*\|\|\s*'1'\s*\}\}/u,
    "Deploy Production workflow must default DEPLOY_SMOKE_CHECK_PRODUCT_PROOF_GATE to '1' for auto-deploys (workflow_run). Found a different default — auto-deploys would skip the public-discovery + API-mirror gate.",
  );

  // The workflow_dispatch input default also flipped to '1' so manual
  // deploys run the gate unless the operator explicitly sets '0'.
  // Keeps the surface consistent: opting OUT requires intent.
  assert.match(
    yaml,
    /smoke_check_product_proof_gate:[\s\S]{0,200}default:\s*"1"/u,
    "workflow_dispatch input smoke_check_product_proof_gate must default to \"1\".",
  );
});

test("deploy-production workflow keeps PRODUCT_PROOF_REQUIRE_WORKER_LOOP opt-in by default", async () => {
  // The worker-loop flag triggers a real on-chain mutation cycle
  // (claim → submit → settle USDC). It MUST stay opt-in to avoid
  // burning signer balance and writing chain state on every CI deploy.
  // The gate-bundle change in this PR only enables the cheap read-only
  // checks (discovery, mirror, trust, schema) — not the worker loop.
  const yaml = await readFile(WORKFLOW_PATH, "utf8");

  assert.match(
    yaml,
    /product_proof_require_worker_loop:[\s\S]{0,200}default:\s*"0"/u,
    "workflow_dispatch input product_proof_require_worker_loop must stay default \"0\" — chain mutation is not safe to run on every deploy.",
  );
  assert.match(
    yaml,
    /DEPLOY_PRODUCT_PROOF_REQUIRE_WORKER_LOOP:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.product_proof_require_worker_loop\s*\|\|\s*'0'\s*\}\}/u,
    "DEPLOY_PRODUCT_PROOF_REQUIRE_WORKER_LOOP must default to '0' for auto-deploys (workflow_run) — chain mutation stays opt-in.",
  );
});
