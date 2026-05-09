import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscoveryManifest } from "../../mcp-server/src/core/discovery-manifest.js";
import { checkProductProofGate } from "./check-product-proof-gate.mjs";

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
      count: 1,
      schemas: [{ $id: "schema://jobs/wikipedia-citation-repair-output" }]
    }],
    ["https://api.averray.com/schemas/jobs/wikipedia-citation-repair-output.json", {
      $id: "schema://jobs/wikipedia-citation-repair-output"
    }]
  ]);

  const seen = [];
  await checkProductProofGate({
    fetchImpl: fakeFetch(responses),
    log: (line) => seen.push(line)
  });

  assert.ok(seen.includes("Product-proof gate passed."));
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
      count: 1,
      schemas: [{ $id: "schema://jobs/wikipedia-citation-repair-output" }]
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
