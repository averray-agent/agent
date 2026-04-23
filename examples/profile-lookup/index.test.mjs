import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProfileLookupSummary,
  parseArgs,
  runProfileLookup
} from "./index.mjs";

const wallet = "0x1234567890123456789012345678901234567890";

test("parseArgs accepts api and wallet flags", () => {
  assert.deepEqual(parseArgs(["--api", "https://api.example", "--wallet", wallet]), {
    apiUrl: "https://api.example",
    wallet
  });
});

test("buildProfileLookupSummary returns compact builder-facing output", () => {
  const summary = buildProfileLookupSummary({
    apiUrl: "https://api.example",
    wallet,
    manifest: {
      name: "Averray",
      discoveryMode: "directory-safe",
      protocols: ["mcp", "http"]
    },
    schemas: {
      count: 1,
      schemas: [{ name: "review-input", $id: "schema://jobs/review-input" }]
    },
    lifecycle: {
      states: ["claimed", "submitted"],
      transitions: [{ from: "claimed", to: "submitted" }]
    },
    profile: {
      wallet,
      reputation: { skill: 10 },
      badges: [{ id: "badge-1" }],
      stats: { approved: 1 }
    }
  });

  assert.equal(summary.discovery.mode, "directory-safe");
  assert.equal(summary.schemas.count, 1);
  assert.deepEqual(summary.schemas.names, ["review-input"]);
  assert.equal(summary.lifecycle.states, 2);
  assert.equal(summary.profile.badgeCount, 1);
});

test("runProfileLookup calls the expected public SDK routes", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/agent-tools.json")) {
      return jsonResponse({ name: "Averray", discoveryMode: "directory-safe", protocols: ["mcp", "http"] });
    }
    if (String(url).endsWith("/schemas/jobs")) {
      return jsonResponse({ count: 1, schemas: [{ name: "review-input" }] });
    }
    if (String(url).endsWith("/session/state-machine")) {
      return jsonResponse({ states: ["claimed"], transitions: [] });
    }
    if (String(url).endsWith(`/agents/${wallet}`)) {
      return jsonResponse({ wallet, reputation: { skill: 1 }, badges: [], stats: {} });
    }
    return jsonResponse({ message: "not found" }, { status: 404 });
  };

  const summary = await runProfileLookup({
    apiUrl: "https://api.example",
    wallet,
    fetchImpl
  });

  assert.deepEqual(calls, [
    "https://api.example/agent-tools.json",
    "https://api.example/schemas/jobs",
    "https://api.example/session/state-machine",
    `https://api.example/agents/${wallet}`
  ]);
  assert.equal(summary.profile.wallet, wallet.toLowerCase());
});

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
