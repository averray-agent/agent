import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_BROKERAGE_POLICIES,
  DEFAULT_CLAIM_BROKERAGE_POLICY,
  brokerageIsUniversal,
  claimBrokerageRefusal,
  resolveClaimBrokeragePolicy,
  shouldBrokerClaim
} from "./claim-brokerage.js";
import { buildDiscoveryManifest } from "./discovery-manifest.js";

// This lands as a seam, not a switch that has been thrown. Production behaviour
// must be byte-identical until someone deliberately sets the variable.
test("the default policy is exactly today's behaviour", () => {
  assert.equal(DEFAULT_CLAIM_BROKERAGE_POLICY, "all");
  assert.equal(resolveClaimBrokeragePolicy({}), "all");
  assert.equal(resolveClaimBrokeragePolicy({ CLAIM_BROKERAGE_POLICY: "  " }), "all");
  assert.equal(shouldBrokerClaim({ source: { type: "external" } }), true);
  assert.equal(shouldBrokerClaim({ id: "curated" }), true);
});

test("an unknown policy is refused rather than silently defaulting", () => {
  assert.throws(
    () => resolveClaimBrokeragePolicy({ CLAIM_BROKERAGE_POLICY: "sometimes" }),
    /must be one of all, curated_only/u
  );
  assert.deepEqual(CLAIM_BROKERAGE_POLICIES, ["all", "curated_only"]);
});

// The catalogue stores external jobs in two shapes. A local classifier that
// handled only the object form would have kept brokering half of them.
test("curated_only excludes external jobs in BOTH shapes the catalogue uses", () => {
  for (const job of [{ source: "external" }, { source: { type: "external" } }]) {
    assert.equal(shouldBrokerClaim(job, "curated_only"), false);
  }
  for (const job of [{ id: "curated" }, { source: { type: "github_issue" } }, {}]) {
    assert.equal(shouldBrokerClaim(job, "curated_only"), true);
  }
});

test("a refused claim explains why and what would change it", () => {
  const error = claimBrokerageRefusal("job-1");
  assert.equal(error.code, "claim_not_brokered");
  assert.match(error.message, /externally posted/u);
  assert.match(error.message, /EscrowCore/u);
  assert.match(error.message, /native gas/u);
});

// The published manifest tells agents outright that "gas is operator-brokered".
// The moment that stops being universally true it is a lie on our public front
// door — and copy drifting from behaviour is the failure this codebase keeps
// repeating. Bind them so the wording cannot outlive the policy.
test("advertised universal brokering cannot outlive the policy", () => {
  assert.equal(brokerageIsUniversal("all"), true);
  assert.equal(brokerageIsUniversal("curated_only"), false);

  const advertised = JSON.stringify(buildDiscoveryManifest({}));
  const claimsUniversalBrokering = /gas is operator-brokered/u.test(advertised);

  assert.equal(
    claimsUniversalBrokering,
    brokerageIsUniversal(DEFAULT_CLAIM_BROKERAGE_POLICY),
    claimsUniversalBrokering
      ? "The manifest still promises universal operator-brokered gas, but the default policy no longer "
        + "brokers every job. Update the manifest copy — and the discovery mirrors — in the same change."
      : "The manifest no longer promises universal brokering while the policy still brokers everything. "
        + "Either restore the copy or narrow the policy; agents are being told less than is true."
  );
});
