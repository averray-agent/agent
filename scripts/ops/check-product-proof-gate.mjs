#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DEFAULT_PUBLIC_SITE_URL = "https://averray.com";
const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_SAMPLE_SCHEMA = "wikipedia-citation-repair-output";

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
  const sampleRef = `schema://jobs/${sampleSchema}`;
  assert.ok(schemaIndex.schemas.some((entry) => entry.$id === sampleRef), `schema index must include ${sampleRef}`);
  const sample = await fetchJson(fetchImpl, `${apiBaseUrl}/schemas/jobs/${sampleSchema}.json`);
  assert.equal(sample.$id, sampleRef);

  if (evidenceFile) {
    log(`Checking hosted worker-loop evidence: ${evidenceFile}`);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    await checkWorkerLoopEvidence(fetchImpl, evidence, { apiBaseUrl });
  } else if (requireWorkerLoop) {
    throw new Error("PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 requires PRODUCT_PROOF_EVIDENCE_FILE.");
  } else {
    log("Worker-loop evidence file not provided; skipping mutation-loop evidence check.");
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
