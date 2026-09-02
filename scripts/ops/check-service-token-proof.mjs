#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_SUBJECT = "0x00000000000000000000000000000000000a11ce";
const DEFAULT_SCOPE = "hosted-smoke-service-token-proof";
const DEFAULT_CAPABILITIES = ["jobs:recommend"];
const DEFAULT_ALLOWED_PATH = "/jobs/recommendations";
const DEFAULT_DENIED_PATHS = ["/account", "/admin/status"];
const SECRET_PATTERN = /Bearer\s+[^\s,}\]]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/u;

export async function checkServiceTokenProof({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }
  const adminToken = string(env.ADMIN_JWT);
  if (!adminToken) {
    throw new Error("CHECK_SERVICE_TOKEN_PROOF=1 requires ADMIN_JWT.");
  }

  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const subject = normalizeWallet(env.SERVICE_TOKEN_PROOF_SUBJECT || DEFAULT_SUBJECT);
  const capabilities = parseCapabilities(env.SERVICE_TOKEN_PROOF_CAPABILITIES || DEFAULT_CAPABILITIES.join(","));
  const scope = string(env.SERVICE_TOKEN_PROOF_SCOPE) || DEFAULT_SCOPE;
  const allowedPath = normalizePath(env.SERVICE_TOKEN_PROOF_ALLOWED_PATH || DEFAULT_ALLOWED_PATH);
  const deniedPaths = parseDeniedPaths(env.SERVICE_TOKEN_PROOF_DENIED_PATHS || DEFAULT_DENIED_PATHS.join(","));
  const tokenTtlSeconds = parsePositiveInteger(env.SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS, 600);
  const runStamp = `${now().toISOString().replace(/[:.]/gu, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const idempotencyPrefix = string(env.SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY) || `service-token-proof-${runStamp}`;
  const evidenceFile = string(env.SERVICE_TOKEN_PROOF_EVIDENCE_FILE);

  let issued;
  let revoked;
  let serviceToken;
  const evidence = {
    proof: "scoped-service-token",
    apiBaseUrl,
    subject,
    scope,
    capabilities,
    allowedPath,
    deniedPaths,
    startedAt: now().toISOString()
  };

  try {
    log(`Checking admin capability surface: ${apiBaseUrl}/auth/session`);
    const adminSession = await fetchJson(fetchImpl, `${apiBaseUrl}/auth/session`, {
      headers: bearer(adminToken)
    });
    assertRole(adminSession, "admin");
    assertCapability(adminSession, "admin:capabilities:read");
    assertCapability(adminSession, "admin:capabilities:grant");
    assertCapability(adminSession, "admin:capabilities:revoke");
    for (const capability of capabilities) {
      assertCapability(adminSession, capability);
    }
    evidence.admin = {
      wallet: adminSession.wallet,
      roles: Array.isArray(adminSession.roles) ? adminSession.roles : [],
      grantCapabilitiesPresent: capabilities
    };

    log(`Issuing scoped service token for ${shortWallet(subject)} (${capabilities.join(", ")})`);
    issued = await fetchJson(fetchImpl, `${apiBaseUrl}/admin/service-tokens`, {
      method: "POST",
      headers: {
        ...bearer(adminToken),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        subject,
        capabilities,
        scope,
        note: "hosted service-token proof",
        tokenTtlSeconds,
        idempotencyKey: `${idempotencyPrefix}:issue`
      }),
      expectedStatus: 201
    });
    assert.equal(issued.tokenKind, "service");
    assert.equal(issued.tokenAvailable, true);
    assert.equal(typeof issued.token, "string");
    assert.equal(issued.grant?.subject, subject.toLowerCase());
    assert.deepEqual([...issued.capabilities].sort(), [...capabilities].sort());
    serviceToken = issued.token;
    evidence.issue = {
      status: 201,
      grantId: issued.grant.id,
      issuedAt: issued.grant.issuedAt,
      expiresAt: issued.expiresAt,
      tokenAvailable: true
    };

    log("Checking service-token /auth/session projection");
    const serviceSession = await fetchJson(fetchImpl, `${apiBaseUrl}/auth/session`, {
      headers: bearer(serviceToken)
    });
    assert.equal(serviceSession.tokenKind, "service");
    assert.equal(serviceSession.serviceToken, true);
    assert.equal(serviceSession.capabilityGrantId, issued.grant.id);
    assert.deepEqual([...serviceSession.capabilities].sort(), [...capabilities].sort());
    assert.deepEqual(serviceSession.roles ?? [], []);
    evidence.serviceSession = {
      tokenKind: serviceSession.tokenKind,
      serviceToken: serviceSession.serviceToken,
      capabilityGrantId: serviceSession.capabilityGrantId,
      capabilities: serviceSession.capabilities,
      roles: serviceSession.roles ?? []
    };

    log(`Checking scoped route allows service token: ${allowedPath}`);
    const allowedBeforeRevoke = await fetchRaw(fetchImpl, `${apiBaseUrl}${allowedPath}`, {
      headers: bearer(serviceToken)
    });
    assert.equal(allowedBeforeRevoke.status, 200);
    evidence.allowedBeforeRevoke = {
      path: allowedPath,
      status: allowedBeforeRevoke.status
    };

    evidence.deniedBeforeRevoke = [];
    for (const path of deniedPaths) {
      log(`Checking ungranted route denies service token: ${path}`);
      const denied = await fetchRaw(fetchImpl, `${apiBaseUrl}${path}`, {
        headers: bearer(serviceToken)
      });
      assert.equal(denied.status, 403, `${path} should reject the scoped service token`);
      evidence.deniedBeforeRevoke.push({ path, status: denied.status });
    }

    log(`Revoking scoped service token grant ${issued.grant.id}`);
    revoked = await revokeServiceToken(fetchImpl, { apiBaseUrl, adminToken, grantId: issued.grant.id, idempotencyPrefix });
    evidence.revoke = {
      status: 200,
      grantId: revoked.grant?.id,
      grantStatus: revoked.grant?.status,
      alreadyRevoked: Boolean(revoked.alreadyRevoked),
      revokedAt: revoked.grant?.revokedAt
    };

    log("Checking revoked service token no longer carries the scoped route");
    const deniedAfterRevoke = await fetchRaw(fetchImpl, `${apiBaseUrl}${allowedPath}`, {
      headers: bearer(serviceToken)
    });
    assert.equal(deniedAfterRevoke.status, 403, "revoked service token should lose its scoped route");
    evidence.deniedAfterRevoke = {
      path: allowedPath,
      status: deniedAfterRevoke.status
    };

    log("Checking list projection redacts token bytes");
    const listed = await fetchJson(fetchImpl, `${apiBaseUrl}/admin/service-tokens?subject=${encodeURIComponent(subject)}&status=revoked&limit=5`, {
      headers: bearer(adminToken)
    });
    assert.ok(Array.isArray(listed.items), "service-token list should include items array");
    const listedGrant = listed.items.find((entry) => entry?.grant?.id === issued.grant.id);
    assert.ok(listedGrant, "revoked service-token grant should be listable");
    assert.equal(listedGrant.tokenAvailable, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(listedGrant, "token"),
      false,
      "service-token list projection must not expose raw token"
    );
    evidence.list = {
      status: 200,
      tokenAvailable: listedGrant.tokenAvailable,
      tokenPresent: Object.prototype.hasOwnProperty.call(listedGrant, "token")
    };

    evidence.completedAt = now().toISOString();
    evidence.status = "passed";
    assertNoSecrets(evidence);
    if (evidenceFile) {
      await writeEvidence(evidenceFile, evidence);
      log(`Wrote service-token proof evidence to ${evidenceFile}`);
    }
    log("Service-token proof passed.");
    return evidence;
  } finally {
    if (issued?.grant?.id && !revoked) {
      try {
        await revokeServiceToken(fetchImpl, { apiBaseUrl, adminToken, grantId: issued.grant.id, idempotencyPrefix });
        log(`Revoked service-token grant ${issued.grant.id} during cleanup.`);
      } catch (error) {
        log(`WARNING: cleanup revoke failed for ${issued.grant.id}: ${error?.message ?? error}`);
      }
    }
  }
}

async function revokeServiceToken(fetchImpl, { apiBaseUrl, adminToken, grantId, idempotencyPrefix }) {
  const body = await fetchJson(fetchImpl, `${apiBaseUrl}/admin/service-tokens/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    headers: {
      ...bearer(adminToken),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      note: "hosted service-token proof complete",
      idempotencyKey: `${idempotencyPrefix}:revoke:${grantId}`
    })
  });
  assert.equal(body.status, "revoked");
  assert.equal(body.grant?.status, "revoked");
  return body;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchRaw(fetchImpl, url, options);
  const expectedStatus = options.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned HTTP ${response.status}; expected ${expectedStatus}: ${truncate(response.text)}`);
  }
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new Error(`${url} did not return valid JSON: ${error.message}`);
  }
}

async function fetchRaw(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body
  });
  return {
    status: response.status,
    text: await response.text()
  };
}

function bearer(token) {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`
  };
}

function assertCapability(session, capability) {
  const capabilities = Array.isArray(session?.capabilities) ? session.capabilities : [];
  assert.ok(capabilities.includes(capability), `admin token must include ${capability}`);
}

function assertRole(session, role) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  assert.ok(roles.includes(role), `admin token must include ${role} role`);
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  assertNoSecrets(body);
  await writeFile(path, body);
}

function assertNoSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (SECRET_PATTERN.test(text)) {
    throw new Error("service-token proof evidence contains token-shaped secret material.");
  }
}

function parseCapabilities(value) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("SERVICE_TOKEN_PROOF_CAPABILITIES must include at least one capability.");
  }
  return [...new Set(entries)].sort();
}

function parseDeniedPaths(value) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);
  return entries.length > 0 ? entries : DEFAULT_DENIED_PATHS;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS must be a positive integer.");
  }
  return parsed;
}

function normalizeWallet(value) {
  const wallet = string(value);
  if (!/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
    throw new Error("SERVICE_TOKEN_PROOF_SUBJECT must be a 0x-prefixed 40-character wallet address.");
  }
  return wallet.toLowerCase();
}

function normalizePath(value) {
  const path = string(value);
  if (!path.startsWith("/")) {
    throw new Error(`route path must start with "/": ${path}`);
  }
  return path;
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/u, "");
}

function string(value) {
  return String(value ?? "").trim();
}

function shortWallet(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function truncate(value, max = 400) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkServiceTokenProof().catch((error) => {
    console.error(error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
  });
}
