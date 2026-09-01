import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertLivePreflight,
  assertServedBundle,
  postRealWorkBundle,
  validateBundle
} from "./post-real-work-job-bundle.mjs";

const bundle = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../docs/real-work-jobs.json", import.meta.url)),
  "utf8"
));

test("ratified bundle validator refuses reward, waiver, count, and attribution drift", () => {
  assert.doesNotThrow(() => validateBundle(structuredClone(bundle)));

  const cases = [
    (candidate) => { candidate.jobs.pop(); },
    (candidate) => { candidate.jobs[0].rewardAmount = 1; },
    (candidate) => { candidate.jobs[0].onboardingWaiverEligible = true; },
    (candidate) => { candidate.jobs[0].source = { type: "external" }; },
    (candidate) => { candidate.poster.classification = "external"; }
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(bundle);
    mutate(candidate);
    assert.throws(() => validateBundle(candidate));
  }
});

test("live preflight requires the ratified Hub, readable bank, and all-or-none presence", () => {
  const healthy = {
    bundle,
    onboarding: { onboarding: { readinessChecks: [{ chain: { chainId: 420420419 } }] } },
    health: { rewardBank: { readable: true, asset: "USDC", liquid: 50.275 } },
    existingJobs: []
  };
  assert.deepEqual(assertLivePreflight(healthy), { bankLiquid: 50.275, alreadyPresent: false });

  assert.throws(
    () => assertLivePreflight({ ...healthy, onboarding: { chain: { chainId: 1 } } }),
    /not consistently reporting Hub chain/u
  );
  assert.throws(
    () => assertLivePreflight({ ...healthy, health: { rewardBank: { readable: true, asset: "USDC", liquid: 6.17 } } }),
    /cannot cover/u
  );
  assert.throws(
    () => assertLivePreflight({ ...healthy, existingJobs: [{ id: bundle.jobs[0].id }] }),
    /Only part/u
  );
});

test("served-bundle gate refuses any external-demand presentation", () => {
  const served = servedRows();
  assert.equal(assertServedBundle(bundle, served), true);

  const external = structuredClone(served);
  external[0].contentTrust = "external-unreviewed";
  external[0].provenance.posterTier = "external-self-serve";
  external[0].provenance.postingRoute = "external-direct-hub";
  external[0].source = "external";
  external[0].sourceType = "external";
  assert.throws(() => assertServedBundle(bundle, external), /misclassified as external demand/u);
});

test("execute posts all three and verifies the complete served bundle", async () => {
  const posted = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/onboarding")) {
      return jsonResponse({ onboarding: { readinessChecks: [{ chain: { chainId: 420420419 } }] } });
    }
    if (url.endsWith("/health")) {
      return jsonResponse({ rewardBank: { readable: true, asset: "USDC", liquid: 50.275 } });
    }
    if (url.endsWith("/jobs") && options.method !== "POST") return jsonResponse([]);
    if (url.endsWith("/admin/jobs") && options.method === "POST") {
      posted.push(JSON.parse(options.body));
      return jsonResponse({ id: posted.at(-1).id }, 201);
    }
    if (url.includes("/jobs?limit=100&state=claimable")) return jsonResponse({ jobs: servedRows() });
    return jsonResponse({ error: "unexpected request" }, 404);
  };
  const logs = [];
  const result = await postRealWorkBundle({
    bundle,
    token: "admin-test-token",
    execute: true,
    fetchImpl,
    logger: { log: (message) => logs.push(message) }
  });

  assert.equal(result.verified, true);
  assert.deepEqual(posted.map(({ id }) => id), bundle.jobs.map(({ id }) => id));
  assert.ok(posted.every(({ idempotencyKey }) => idempotencyKey.startsWith(`${bundle.bundleId}:`)));
  assert.match(logs.at(-1), /all three are claimable/u);
});

function servedRows() {
  return bundle.jobs.map((job) => ({
    id: job.id,
    claimable: true,
    effectiveState: "claimable",
    reward: { asset: "USDC", amount: 2 },
    onboardingWaiverEligible: false,
    contentTrust: "operator-curated",
    provenance: {
      posterTier: "operator-curated",
      postingRoute: "curated"
    },
    source: job.source.type === "github_issue" ? "github" : "open_data",
    sourceType: job.source.type
  }));
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}
