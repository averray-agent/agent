#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DEFAULT_ESCROW_ASSET } from "../../mcp-server/src/core/assets.js";
import { listBuiltinJobSchemas } from "../../mcp-server/src/core/job-schema-registry.js";

const DEFAULT_PUBLIC_SITE_URL = "https://averray.com";
const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_SAMPLE_SCHEMA = "wikipedia-citation-repair-output";
const REQUIRED_FIRST_WAVE_SCHEMA_REFS = listBuiltinJobSchemas().map((schema) => schema.$id);
const REQUIRED_ESCROW_ASSET = {
  symbol: DEFAULT_ESCROW_ASSET.symbol,
  address: DEFAULT_ESCROW_ASSET.address.toLowerCase(),
  assetClass: DEFAULT_ESCROW_ASSET.assetClass,
  assetId: DEFAULT_ESCROW_ASSET.assetId,
  decimals: DEFAULT_ESCROW_ASSET.decimals,
  minBalanceRaw: String(DEFAULT_ESCROW_ASSET.minBalanceRaw)
};

export async function checkProductProofGate({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const publicSiteUrl = stripTrailingSlash(env.PUBLIC_SITE_URL || DEFAULT_PUBLIC_SITE_URL);
  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const publicDiscoveryUrl = env.PUBLIC_DISCOVERY_URL || `${publicSiteUrl}/.well-known/agent-tools.json`;
  const sampleSchema = env.PRODUCT_PROOF_SAMPLE_SCHEMA || DEFAULT_SAMPLE_SCHEMA;
  const requireWorkerLoop = enabled(env.PRODUCT_PROOF_REQUIRE_WORKER_LOOP);
  const evidenceFile = env.PRODUCT_PROOF_EVIDENCE_FILE || "";

  log(`Checking public discovery manifest: ${publicDiscoveryUrl}`);
  const publicManifest = await fetchJson(fetchImpl, publicDiscoveryUrl);

  log(`Checking API discovery mirror: ${apiBaseUrl}/agent-tools.json`);
  const apiManifest = await fetchJson(fetchImpl, `${apiBaseUrl}/agent-tools.json`);
  assert.deepEqual(publicManifest, apiManifest, "public discovery manifest must match the API mirror");
  assert.equal(publicManifest.discoveryUrl, publicDiscoveryUrl);
  assert.equal(publicManifest.baseUrl, apiBaseUrl);
  assertManifestTrustDocs(publicManifest);

  log("Checking onboarding agrees with discovery manifest");
  const onboarding = await fetchJson(fetchImpl, `${apiBaseUrl}/onboarding`);
  assert.equal(onboarding.name, publicManifest.name);
  assert.equal(onboarding.discoveryUrl, publicManifest.discoveryUrl);
  assert.equal(onboarding.discoveryMode, publicManifest.discoveryMode);
  assert.deepEqual(onboarding.protocols, publicManifest.protocols);
  assert.deepEqual(onboarding.onboarding?.starterFlow, publicManifest.onboarding?.starterFlow);
  assert.equal(onboarding.auth?.schemeId, publicManifest.auth?.schemeId);
  assert.deepEqual(onboarding.tools, publicManifest.tools.map((tool) => tool.name));

  log("Checking public trust and schema pages");
  await fetchPageWithMarkers(fetchImpl, `${publicSiteUrl}/trust/`, [
    "Averray — Trust",
    "Open discovery manifest",
    "https://api.averray.com/onboarding"
  ]);
  await fetchPageWithMarkers(fetchImpl, `${publicSiteUrl}/schemas/`, [
    "Averray — Schemas",
    "agent-badge-v1.json",
    "agent-profile-v1.json"
  ]);
  await fetchPageWithMarkers(fetchImpl, `${publicSiteUrl}/agents/`, [
    "Averray — For agents",
    "Read /.well-known/agent-tools.json",
    "https://api.averray.com/onboarding"
  ]);
  await fetchPageWithMarkers(fetchImpl, `${publicSiteUrl}/builders/`, [
    "Averray — Builders",
    "https://api.averray.com/schemas/jobs"
  ]);
  await fetchPageWithMarkers(fetchImpl, `${publicSiteUrl}/llms.txt`, [
    "Discovery manifest: https://averray.com/.well-known/agent-tools.json",
    "Onboarding: https://api.averray.com/onboarding"
  ]);

  log("Checking public identity schemas");
  const badgeSchema = await fetchJson(fetchImpl, publicManifest.schemas.agentBadge);
  assert.equal(badgeSchema.$id, "https://averray.com/schemas/agent-badge-v1.json");
  const profileSchema = await fetchJson(fetchImpl, publicManifest.schemas.agentProfile);
  assert.equal(profileSchema.$id, "https://averray.com/schemas/agent-profile-v1.json");

  log("Checking job schema index and sample schema");
  const schemaIndex = await fetchJson(fetchImpl, publicManifest.schemas.jobSchemasIndex);
  assert.ok(Number.isInteger(schemaIndex.count) && schemaIndex.count > 0, "schema index count must be positive");
  assert.ok(Array.isArray(schemaIndex.schemas), "schema index must include schemas array");
  assert.equal(schemaIndex.count, schemaIndex.schemas.length);
  const schemaRefs = new Set(schemaIndex.schemas.map((entry) => entry.$id));
  for (const schemaRef of REQUIRED_FIRST_WAVE_SCHEMA_REFS) {
    assert.ok(schemaRefs.has(schemaRef), `schema index must include first-wave schema ${schemaRef}`);
  }
  const sampleRef = `schema://jobs/${sampleSchema}`;
  assert.ok(schemaRefs.has(sampleRef), `schema index must include ${sampleRef}`);
  const sample = await fetchJson(fetchImpl, `${apiBaseUrl}/schemas/jobs/${sampleSchema}.json`);
  assert.equal(sample.$id, sampleRef);

  if (requireWorkerLoop && evidenceFile) {
    log(`Checking hosted worker-loop evidence: ${evidenceFile}`);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    await checkWorkerLoopEvidence(fetchImpl, evidence, { apiBaseUrl });
  } else if (requireWorkerLoop) {
    throw new Error("PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 requires PRODUCT_PROOF_EVIDENCE_FILE.");
  } else {
    log("Worker-loop evidence is not required; skipping mutation-loop evidence check.");
  }

  log("Product-proof gate passed.");
}

function assertManifestTrustDocs(manifest) {
  for (const [key, suffix] of [
    ["productionChecklist", "/docs/PRODUCTION_CHECKLIST.md"],
    ["threatModel", "/docs/THREAT_MODEL.md"],
    ["noToken", "/docs/NO_TOKEN.md"],
    ["week12Gate", "/docs/WEEK12_GATE.md"],
    ["productProofGate", "/docs/PRODUCT_PROOF_GATE.md"],
    ["disputeCodes", "/docs/DISPUTE_CODES.md"],
    ["arbitrationMigration", "/docs/ARBITRATION_MIGRATION.md"]
  ]) {
    assert.ok(
      String(manifest.docs?.[key] || "").endsWith(suffix),
      `manifest.docs.${key} must link ${suffix}`
    );
  }
}

async function checkWorkerLoopEvidence(fetchImpl, evidence, { apiBaseUrl }) {
  assert.ok(evidence && typeof evidence === "object", "worker-loop evidence must be a JSON object");
  assert.ok(evidence.sessionId, "worker-loop evidence requires sessionId");
  assert.ok(evidence.jobId, "worker-loop evidence requires jobId");
  assert.ok(evidence.wallet, "worker-loop evidence requires wallet");
  assertWorkerLoopCompletionEvidence(evidence, { apiBaseUrl });

  const badgeUrl = evidence.badgeUrl || `${apiBaseUrl}/badges/${encodeURIComponent(evidence.sessionId)}`;
  const profileUrl = evidence.profileUrl || `${apiBaseUrl}/agents/${encodeURIComponent(evidence.wallet)}`;

  const badge = await fetchJson(fetchImpl, badgeUrl);
  assert.equal(badge.averray?.schemaVersion, "v1");
  assert.equal(badge.averray?.sessionId, evidence.sessionId);
  assert.equal(badge.averray?.jobId, evidence.jobId);
  assert.equal(String(badge.averray?.worker || "").toLowerCase(), String(evidence.wallet).toLowerCase());

  const profile = await fetchJson(fetchImpl, profileUrl);
  assert.equal(profile.schemaVersion, "v1");
  assert.equal(String(profile.wallet || "").toLowerCase(), String(evidence.wallet).toLowerCase());
  assert.ok(
    Array.isArray(profile.badges) && profile.badges.some((badgeEntry) => (
      badgeEntry.sessionId === evidence.sessionId && badgeEntry.jobId === evidence.jobId
    )),
    "profile badges must include the verified worker-loop session"
  );
}

function assertWorkerLoopCompletionEvidence(evidence, { apiBaseUrl }) {
  if (evidence.apiBaseUrl) {
    assert.equal(stripTrailingSlash(evidence.apiBaseUrl), apiBaseUrl, "worker-loop evidence apiBaseUrl must match the checked API host");
  }
  assert.equal(evidence.verificationOutcome, "approved", "worker-loop evidence requires approved verificationOutcome");
  assert.equal(evidence.submitStatus, "submitted", "worker-loop evidence requires submitted submitStatus");
  assert.equal(evidence.sessionStatus, "resolved", "worker-loop evidence requires resolved sessionStatus");
  assert.ok(Date.parse(evidence.completedAt) > 0, "worker-loop evidence requires completedAt timestamp");

  const settlement = evidence.settlementReadiness;
  assert.ok(settlement?.settlementReady === true, "worker-loop evidence requires settlementReadiness.settlementReady=true");
  const asset = settlement.asset;
  assert.equal(asset?.symbol, REQUIRED_ESCROW_ASSET.symbol, "worker-loop evidence settlement asset must be USDC");
  assert.equal(String(asset?.address ?? "").toLowerCase(), REQUIRED_ESCROW_ASSET.address, "worker-loop evidence settlement asset address must match canonical USDC precompile");
  assert.equal(asset?.assetClass, REQUIRED_ESCROW_ASSET.assetClass, "worker-loop evidence settlement asset class must match canonical USDC");
  assert.equal(Number(asset?.assetId), REQUIRED_ESCROW_ASSET.assetId, "worker-loop evidence settlement asset id must match canonical USDC");
  assert.equal(Number(asset?.decimals), REQUIRED_ESCROW_ASSET.decimals, "worker-loop evidence settlement asset decimals must match canonical USDC");
  assert.equal(String(asset?.minBalanceRaw ?? ""), REQUIRED_ESCROW_ASSET.minBalanceRaw, "worker-loop evidence settlement asset minBalanceRaw must match canonical USDC");
  assert.equal(asset?.approved, true, "worker-loop evidence settlement asset must be approved");
  assert.equal(settlement.roles?.signerIsVerifier, true, "worker-loop evidence requires signer verifier role");
  assert.equal(settlement.roles?.escrowIsServiceOperator, true, "worker-loop evidence requires EscrowCore service-operator role");
  assert.equal(settlement.roles?.agentAccountIsServiceOperator, true, "worker-loop evidence requires AgentAccountCore service-operator role");

  assert.equal(evidence.rewardReadiness?.asset, REQUIRED_ESCROW_ASSET.symbol, "worker-loop evidence reward readiness must be USDC");
  assertRawAtLeast(
    evidence.rewardReadiness?.rewardRaw,
    REQUIRED_ESCROW_ASSET.minBalanceRaw,
    "worker-loop evidence reward must clear the USDC minBalance"
  );
  assert.equal(evidence.rewardReadiness?.minBalanceRaw, REQUIRED_ESCROW_ASSET.minBalanceRaw, "worker-loop evidence reward minBalance must match canonical USDC");

  assert.equal(evidence.liquidityReadiness?.wallet?.toLowerCase(), evidence.wallet.toLowerCase(), "worker-loop evidence liquidity wallet must match worker wallet");
  assert.equal(evidence.liquidityReadiness?.asset, REQUIRED_ESCROW_ASSET.symbol, "worker-loop evidence liquidity readiness must be USDC");
  assertRawAtLeast(
    evidence.liquidityReadiness?.availableRaw,
    evidence.liquidityReadiness?.requiredRaw,
    "worker-loop evidence liquidity must cover required reward"
  );

  assert.equal(evidence.preflightReadiness?.jobId, evidence.jobId, "worker-loop evidence preflight jobId must match evidence jobId");
  assert.equal(String(evidence.preflightReadiness?.wallet ?? "").toLowerCase(), evidence.wallet.toLowerCase(), "worker-loop evidence preflight wallet must match worker wallet");
  assert.equal(evidence.preflightReadiness?.eligible, true, "worker-loop evidence requires eligible preflight");
  assert.equal(evidence.preflightReadiness?.claimable, true, "worker-loop evidence requires claimable preflight");
  assert.notEqual(evidence.preflightReadiness?.currentWalletCanClaim, false, "worker-loop evidence requires currentWalletCanClaim not false");
  assert.equal(evidence.preflightReadiness?.requiredOutputSchema, "schema://jobs/product-proof-worker-loop", "worker-loop evidence must use the product-proof output schema");

  assert.equal(evidence.validationReadiness?.jobId, evidence.jobId, "worker-loop evidence validation jobId must match evidence jobId");
  assert.equal(evidence.validationReadiness?.valid, true, "worker-loop evidence requires valid schema validation before claim");
  assert.equal(evidence.validationReadiness?.schemaRef, "schema://jobs/product-proof-worker-loop", "worker-loop evidence validation schema must match product-proof output schema");
  assert.equal(evidence.validationReadiness?.schemaValidates, "payload.submission", "worker-loop evidence validation must target payload.submission");
  assert.equal(evidence.validationReadiness?.submissionKind, "structured", "worker-loop evidence validation must use structured submission");
  assert.equal(evidence.validationReadiness?.validatedBeforeClaim, true, "worker-loop evidence must prove validation happened before claim");

  assert.ok(evidence.invalidValidationReadiness, "worker-loop evidence requires an invalid schema validation proof");
  assert.equal(evidence.invalidValidationReadiness.jobId, evidence.jobId, "worker-loop evidence invalid validation jobId must match evidence jobId");
  assert.equal(evidence.invalidValidationReadiness?.valid, false, "worker-loop evidence requires an invalid schema validation proof");
  assert.equal(evidence.invalidValidationReadiness?.submitSafe, false, "worker-loop evidence invalid validation must not be submit safe");
  assert.equal(evidence.invalidValidationReadiness?.schemaRef, "schema://jobs/product-proof-worker-loop", "worker-loop evidence invalid validation schema must match product-proof output schema");
  assert.equal(evidence.invalidValidationReadiness?.schemaValidates, "payload.submission", "worker-loop evidence invalid validation must target payload.submission");
  assert.equal(evidence.invalidValidationReadiness?.checkedBeforeClaim, true, "worker-loop evidence invalid validation must happen before claim");
  assert.equal(evidence.invalidValidationReadiness?.submitAttempted, false, "worker-loop evidence invalid validation must not call submit");
  assert.ok(
    evidence.invalidValidationReadiness?.path || evidence.invalidValidationReadiness?.message,
    "worker-loop evidence invalid validation must include a path or message"
  );

  assert.equal(evidence.claimReadiness?.sessionId, evidence.sessionId, "worker-loop evidence claim sessionId must match evidence sessionId");
  assert.ok(evidence.claimReadiness?.status, "worker-loop evidence requires claim status");
}

function assertRawAtLeast(value, minimum, message) {
  const actual = parseRawAmount(value, message);
  const expected = parseRawAmount(minimum, message);
  assert.ok(actual >= expected, `${message}: ${actual} < ${expected}`);
}

function parseRawAmount(value, label) {
  assert.ok(typeof value === "string" && /^\d+$/u.test(value), `${label}: expected raw integer string`);
  return BigInt(value);
}

async function fetchPageWithMarkers(fetchImpl, url, markers) {
  const text = await fetchText(fetchImpl, url);
  for (const marker of markers) {
    assert.ok(text.includes(marker), `${url} must include marker: ${marker}`);
  }
}

async function fetchJson(fetchImpl, url) {
  const text = await fetchText(fetchImpl, url);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} did not return valid JSON: ${error.message}`);
  }
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json,text/html,text/plain" }
  });
  if (!response?.ok) {
    throw new Error(`${url} returned HTTP ${response?.status ?? "unknown"}`);
  }
  return response.text();
}

function enabled(value) {
  return /^(1|true|yes)$/iu.test(String(value || ""));
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkProductProofGate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
