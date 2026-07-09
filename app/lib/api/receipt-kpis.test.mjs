import test from "node:test";
import assert from "node:assert/strict";
import { COSIGN_TARGET_PCT, coSignKpiState } from "./receipt-kpis.js";

const signer = (identified = true) => ({ identified });

test("co-sign KPI has no target chip when there are no rows", () => {
  assert.deepEqual(coSignKpiState([]), {
    value: "—",
    unit: "",
    meta: "no receipt rows in this view",
    metaTone: "muted",
    status: "unknown",
  });
});

test("co-sign KPI is unknowable when /badges has not emitted signer identities", () => {
  assert.equal(
    coSignKpiState([{ signers: [signer(false), signer(false)] }]).meta,
    "signer identities not yet emitted by /badges"
  );
  assert.equal(coSignKpiState([{ signers: [signer(false)] }]).status, "unknown");
});

test("co-sign KPI reports below target when identified co-sign rate is low", () => {
  const state = coSignKpiState([
    { signers: [signer(), signer()] },
    { signers: [signer()] },
  ]);
  assert.equal(COSIGN_TARGET_PCT, 95);
  assert.equal(state.value, "50.0");
  assert.equal(state.status, "below");
  assert.equal(state.metaTone, "warn");
});

test("co-sign KPI reports within target only at or above named target", () => {
  const state = coSignKpiState([
    { signers: [signer(), signer()] },
    { signers: [signer(), signer(), signer()] },
  ]);
  assert.equal(state.value, "100.0");
  assert.equal(state.status, "within");
  assert.equal(state.metaTone, "ok");
});
