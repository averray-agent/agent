import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listAllKnownCapabilities } from "../../mcp-server/src/auth/capabilities.js";
import {
  WORKER_CAPABILITY_BUNDLES,
  buildWorkerSummary,
  parseArgs,
  runServiceTokenWorker
} from "./index.mjs";

const wallet = "0x1234567890123456789012345678901234567890";
const moduleDir = dirname(fileURLToPath(import.meta.url));

test("every capability in every worker bundle is a real platform capability", () => {
  const known = listAllKnownCapabilities();
  for (const [bundleName, capabilities] of Object.entries(WORKER_CAPABILITY_BUNDLES)) {
    for (const capability of capabilities) {
      assert.ok(
        known.has(capability),
        `WORKER_CAPABILITY_BUNDLES.${bundleName} references unknown capability '${capability}'. Check mcp-server/src/auth/capabilities.js.`
      );
    }
  }
});

test("no worker bundle includes any admin:* capability", () => {
  // The whole point of a service token is that the worker cannot
  // mint other tokens, change policy, or steer treasury. A bundle
  // that quietly includes an admin:* capability would defeat that.
  for (const [bundleName, capabilities] of Object.entries(WORKER_CAPABILITY_BUNDLES)) {
    const admin = capabilities.filter((capability) => capability.startsWith("admin:"));
    assert.deepEqual(
      admin,
      [],
      `WORKER_CAPABILITY_BUNDLES.${bundleName} must not contain admin:* capabilities. Found: ${admin.join(", ")}`
    );
  }
});

test("no worker bundle includes operator-only job-tree controls", () => {
  // Same protection for the non-prefixed admin-tier capabilities that
  // would let a worker create/ingest/lifecycle jobs or fire recurring
  // schedulers. These live in the `admin` role expansion but lack
  // the admin: prefix, so the previous test does not catch them.
  const FORBIDDEN = new Set([
    "jobs:create",
    "jobs:ingest",
    "jobs:fire-recurring",
    "jobs:lifecycle",
    "jobs:pause-recurring",
    "jobs:resume-recurring",
    "jobs:timeline",
    "policies:propose",
    "xcm:observe",
    "xcm:finalize",
    "disputes:release",
    "disputes:verdict"
  ]);
  for (const [bundleName, capabilities] of Object.entries(WORKER_CAPABILITY_BUNDLES)) {
    const leaked = capabilities.filter((capability) => FORBIDDEN.has(capability));
    assert.deepEqual(
      leaked,
      [],
      `WORKER_CAPABILITY_BUNDLES.${bundleName} leaks operator-only capability ${leaked.join(", ")}.`
    );
  }
});

test("every capability mentioned in the operator pack doc exists in the registry", async () => {
  // Catches doc drift: if a capability is renamed in the registry
  // but the operator pack still references the old name, this test
  // fails with the bad capability called out by name.
  const docPath = resolve(moduleDir, "../../docs/SERVICE_TOKEN_OPERATOR_PACK.md");
  const docSource = await readFile(docPath, "utf8");
  const known = listAllKnownCapabilities();
  // Pull capability tokens out of backticked spans.
  const matches = docSource.match(/`([a-z]+:[a-z][a-z:-]*)`/gu) ?? [];
  const candidates = matches
    .map((match) => match.replace(/^`|`$/gu, ""))
    .filter((value) => /^[a-z]+:[a-z][a-z:-]*$/u.test(value));
  // Filter to *capability-shaped* tokens — not, say, route fragments.
  // Heuristic: every capability in the registry has the same single-
  // or double-colon shape (`jobs:claim`, `admin:capabilities:grant`).
  // We accept the value as a capability-claim if it matches the
  // capability shape and explicitly compare against `known`.
  const referenced = new Set(candidates);
  const missing = [];
  for (const capability of referenced) {
    if (!known.has(capability) && looksLikeCapability(capability)) {
      missing.push(capability);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `SERVICE_TOKEN_OPERATOR_PACK.md references capabilities that do not exist in the registry: ${missing.join(", ")}`
  );
});

test("parseArgs accepts --api, --token, --wallet", () => {
  assert.deepEqual(
    parseArgs(["--api", "https://api.example", "--token", "tok-123", "--wallet", wallet]),
    { apiUrl: "https://api.example", token: "tok-123", wallet }
  );
});

test("buildWorkerSummary returns a compact, lower-cased projection", () => {
  const summary = buildWorkerSummary({
    apiUrl: "https://api.example",
    wallet: wallet.toUpperCase(),
    health: { ok: true, status: "ok" },
    profile: { wallet: wallet.toUpperCase(), reputation: { skill: 7 }, badges: [{ id: "b1" }] }
  });
  assert.equal(summary.health.ok, true);
  assert.equal(summary.profile.wallet, wallet);
  assert.equal(summary.profile.badgeCount, 1);
});

test("runServiceTokenWorker sends the bearer token on the authenticated read", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/health")) {
      return jsonResponse({ ok: true, status: "ok" });
    }
    if (String(url).endsWith(`/agents/${wallet}`)) {
      return jsonResponse({ wallet, reputation: { skill: 1 }, badges: [], stats: {} });
    }
    return jsonResponse({ message: "not found" }, { status: 404 });
  };

  const summary = await runServiceTokenWorker({
    apiUrl: "https://api.example",
    token: "worker-token-secret",
    wallet,
    fetchImpl
  });

  const profileCall = calls.find((call) => call.url.endsWith(`/agents/${wallet}`));
  assert.ok(profileCall, "profile route should be hit");
  assert.equal(
    profileCall.init.headers.get("authorization"),
    "Bearer worker-token-secret",
    "the worker token must be forwarded as a Bearer auth header"
  );
  assert.equal(summary.profile.wallet, wallet.toLowerCase());
});

test("runServiceTokenWorker refuses to run without a token rather than falling through to anonymous reads", async () => {
  await assert.rejects(
    () => runServiceTokenWorker({
      apiUrl: "https://api.example",
      wallet,
      fetchImpl: async () => {
        throw new Error("must not be reached without a token");
      }
    }),
    /worker service token is required/u
  );
});

test("runServiceTokenWorker rejects a malformed wallet before any HTTP call", async () => {
  await assert.rejects(
    () => runServiceTokenWorker({
      apiUrl: "https://api.example",
      token: "worker-token-secret",
      wallet: "not-a-wallet",
      fetchImpl: async () => {
        throw new Error("must not be reached for invalid wallet");
      }
    }),
    /20-byte hex address/u
  );
});

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function looksLikeCapability(value) {
  // The doc references a number of strings inside backticks that
  // *aren't* capabilities (e.g. `getAgentProfile`, `expiresAt`).
  // Capability-shaped strings always contain a colon. Anything
  // without a colon is filtered out before this point, so the rule
  // here is "if it has a colon and isn't in the registry, it's a
  // typo".
  return value.includes(":");
}
