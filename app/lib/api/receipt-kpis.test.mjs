import test from "node:test";
import assert from "node:assert/strict";
import { COSIGN_TARGET_PCT, coSignKpiState, coSignMandateTags } from "./receipt-kpis.js";

const signer = (identified = true) => ({ identified });

const MANDATE_TAG = "receipt/operator-verifier-cosign@v2";

// Mirrors the live built-in receipt/operator-verifier-cosign@v1: record
// operator+verifier identities when observable, omit when not. Attribution,
// not a mandate — must never produce a below-target alarm on its own.
const attributionPolicy = {
  tag: "receipt/operator-verifier-cosign@v1",
  state: "Active",
  revision: 1,
  rule: {
    v1: JSON.stringify({
      kind: "receipt.co_sign",
      require: { roles: ["operator", "verifier"], identity_source: "live_chain_roles" },
      on_missing_identity: "omit",
    }),
  },
};

// Mirrors the live built-in claim/deps-sec-only@v4: run receipts produced
// under this claim policy are co-signed by the verifier handler.
const depsClaimPolicy = {
  tag: "claim/deps-sec-only@v4",
  state: "Active",
  revision: 4,
  rule: {
    v4: JSON.stringify({
      kind: "claim.auto",
      scope: "deps-bump",
      receipt: { co_sign: ["verifier_handler"], attach_cvss_trail: true },
    }),
  },
};

const mandatePolicy = (overrides = {}) => ({
  tag: MANDATE_TAG,
  state: "Active",
  revision: 2,
  rule: {
    v2: JSON.stringify({
      kind: "receipt.co_sign",
      require: { roles: ["operator", "verifier"] },
      on_missing_identity: "block",
    }),
  },
  ...overrides,
});

const badgeRow = (signers = [signer()]) => ({ policy: "coding/tier-1", signers });
const requiredRow = (signers) => ({ policy: MANDATE_TAG, signers });

test("co-sign KPI has no target chip when there are no rows", () => {
  assert.deepEqual(coSignKpiState([], []), {
    value: "—",
    unit: "",
    meta: "no receipt rows in this view",
    metaTone: "muted",
    status: "unknown",
  });
});

test("co-sign KPI cannot claim anything while the policy feed is not readable", () => {
  const state = coSignKpiState([badgeRow()], undefined, "down");
  assert.equal(state.status, "unknown");
  assert.equal(state.meta, "policy feed unreachable — retrying · co-sign requirement unknown");
  assert.equal(state.metaTone, "muted");
});

test("policy feed loading and unreachable render as themselves, not as empty", () => {
  assert.equal(
    coSignKpiState([badgeRow()], undefined, "loading").meta,
    "policy feed loading · co-sign requirement unknown"
  );
  assert.equal(
    coSignKpiState([badgeRow()], undefined, "locked").meta,
    "policy feed unreachable — retrying · co-sign requirement unknown"
  );
  // No presence provided (or an unreadable "live" payload) degrades honestly.
  assert.equal(
    coSignKpiState([badgeRow()], undefined).meta,
    "policy feed unreachable — retrying · co-sign requirement unknown"
  );
  assert.equal(
    coSignKpiState([badgeRow()], { not: "an array" }, "live").meta,
    "policy feed unreachable — retrying · co-sign requirement unknown"
  );
});

test("attribution-only co-sign policy (on_missing_identity: omit) is not a mandate", () => {
  assert.deepEqual([...coSignMandateTags([attributionPolicy])], []);
});

test("claim policies that co-sign their receipts and co_sign.min gates are mandates", () => {
  assert.deepEqual([...coSignMandateTags([depsClaimPolicy])], ["claim/deps-sec-only@v4"]);
  const settleGate = {
    tag: "settle/quorum@v1",
    state: "Active",
    revision: 1,
    rule: { v1: JSON.stringify({ kind: "settle.gate", require: { "co_sign.min": 2 } }) },
  };
  assert.deepEqual([...coSignMandateTags([settleGate])], ["settle/quorum@v1"]);
});

test("non-Active policies and unparseable rules never mandate", () => {
  assert.deepEqual([...coSignMandateTags([mandatePolicy({ state: "Retired" })])], []);
  assert.deepEqual(
    [...coSignMandateTags([mandatePolicy({ rule: { v2: "{not json" } })])],
    []
  );
});

// The live regression: 181 badge receipts, one identified signer each, and
// no active policy requiring a co-sign chain — the card read
// "0.0% · BELOW TARGET 95%". It must render neutral instead.
test("co-sign KPI is neutral when no active policy requires co-signing", () => {
  const rows = [badgeRow(), badgeRow(), badgeRow()];
  const state = coSignKpiState(rows, [attributionPolicy, depsClaimPolicy]);
  assert.deepEqual(state, {
    value: "—",
    unit: "",
    meta: "co-signing not required by any active policy",
    metaTone: "muted",
    status: "not-required",
  });
});

test("a retired mandate does not put receipts back under requirement", () => {
  const state = coSignKpiState(
    [requiredRow([signer()])],
    [mandatePolicy({ state: "Retired" })]
  );
  assert.equal(state.status, "not-required");
});

test("co-sign KPI reports below target over policy-required receipts only", () => {
  const rows = [
    requiredRow([signer(), signer()]),
    requiredRow([signer()]),
    badgeRow(), // not policy-required — must not join the denominator
  ];
  const state = coSignKpiState(rows, [mandatePolicy(), attributionPolicy]);
  assert.equal(COSIGN_TARGET_PCT, 95);
  assert.equal(state.value, "50.0");
  assert.equal(state.unit, "%");
  assert.equal(state.meta, "1 of 2 policy-required receipts · identified signer chain");
  assert.equal(state.status, "below");
  assert.equal(state.metaTone, "warn");
});

test("co-sign KPI reports within target only at or above named target", () => {
  const rows = [
    ...Array.from({ length: 19 }, () => requiredRow([signer(), signer()])),
    requiredRow([signer()]),
  ];
  const state = coSignKpiState(rows, [mandatePolicy()]);
  assert.equal(state.value, "95.0");
  assert.equal(state.status, "within");
  assert.equal(state.metaTone, "ok");
});

test("a required receipt missing its whole chain counts against the rate", () => {
  const rows = [requiredRow([signer(false)]), requiredRow([signer(), signer()])];
  const state = coSignKpiState(rows, [mandatePolicy()]);
  assert.equal(state.value, "50.0");
  assert.equal(state.status, "below");
});

test("run receipts match a mandate through policyTags on the raw list row", () => {
  const runRow = {
    policy: "reputation/tier-1",
    signers: [signer()],
    listRow: { policyTags: ["claim/deps-sec-only@v4"] },
  };
  const state = coSignKpiState([runRow], [depsClaimPolicy]);
  assert.equal(state.status, "below");
  assert.equal(state.meta, "0 of 1 policy-required receipts · identified signer chain");
});

test("co-sign KPI stays unknowable when /badges has not emitted signer identities", () => {
  const rows = [requiredRow([signer(false), signer(false)])];
  const state = coSignKpiState(rows, [mandatePolicy()]);
  assert.equal(state.status, "unknown");
  assert.equal(state.meta, "signer identities not yet emitted by /badges");
});
