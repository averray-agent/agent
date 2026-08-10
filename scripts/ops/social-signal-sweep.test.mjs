import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  EXPECTED_SCHEMA_VERSION,
  VETO_REASONS,
  assessPayload,
  evaluateSignals,
  readField,
  socialSignalSweep,
  vetoFor
} from "./social-signal-sweep.mjs";

const NOW_ISO = "2026-08-10T07:17:00.000Z";
const GENERATED_AT_MS = Date.parse(NOW_ISO);

function field(value, status = "fresh") {
  return { value, unit: "count", status, readAtMs: GENERATED_AT_MS, source: "indexer", proof: "chain" };
}

function snapshot({ settled = 4, external = 0, settledStatus = "fresh", externalStatus = "fresh", schemaVersion = EXPECTED_SCHEMA_VERSION } = {}) {
  return {
    schemaVersion,
    generatedAtMs: GENERATED_AT_MS,
    chain: { head: field(1_234_567) },
    flow: {
      jobsSettled: {
        last24h: field(1),
        last7d: field(3),
        allTime: field(settled, settledStatus)
      },
      composition24h: {
        platformVerificationRuns: field(2),
        ingested: field(1),
        external: field(external, externalStatus),
        unclassified: field(0)
      }
    }
  };
}

test("a sweep with nothing new is quiet and fires nothing", () => {
  const result = evaluateSignals({ snapshot: snapshot({ settled: 4 }), state: {}, nowIso: NOW_ISO });

  assert.equal(result.quiet, true);
  assert.deepEqual(result.fired, []);
  assert.deepEqual(result.vetoed, []);
});

test("a settlement milestone fires on the crossing", () => {
  const result = evaluateSignals({ snapshot: snapshot({ settled: 12 }), state: {}, nowIso: NOW_ISO });

  assert.equal(result.quiet, false);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].signalId, "jobs-settled-10");
  assert.match(result.fired[0].claim, /passed 10 settled jobs/u);
  assert.equal(result.nextState.highestSettlementMilestone, 10);
});

test("the milestone claim says 'passed', never the exact live count", () => {
  // Production read 142 settled while crossing the 100 milestone. A claim of
  // "100 jobs have settled" would be false against the field it rests on.
  const result = evaluateSignals({ snapshot: snapshot({ settled: 142 }), state: {}, nowIso: NOW_ISO });

  assert.equal(result.fired[0].claim, "Averray mainnet has passed 100 settled jobs");
  assert.equal(result.fired[0].checkedAgainst.fields["flow.jobsSettled.allTime"].value, 142);
});

test("a first run calibrates and announces nothing", () => {
  const result = evaluateSignals({
    snapshot: snapshot({ settled: 142 }),
    state: {},
    nowIso: NOW_ISO,
    firstRun: true
  });

  assert.equal(result.quiet, true, "day one must not open with months-old news");
  assert.deepEqual(result.fired, []);
  assert.equal(result.seeded.length, 1);
  assert.equal(result.seeded[0].signalId, "jobs-settled-100");
  assert.equal(result.nextState.highestSettlementMilestone, 100, "seeding still advances state");
});

test("the run after a first run announces normally", () => {
  const first = evaluateSignals({
    snapshot: snapshot({ settled: 142 }),
    state: {},
    nowIso: NOW_ISO,
    firstRun: true
  });
  const second = evaluateSignals({
    snapshot: snapshot({ settled: 512 }),
    state: first.nextState,
    nowIso: NOW_ISO
  });

  assert.equal(second.fired.length, 1);
  assert.equal(second.fired[0].signalId, "jobs-settled-500");
});

test("a milestone that already fired never fires again", () => {
  const state = { firedSignals: { "jobs-settled-10": { firedAt: NOW_ISO } }, highestSettlementMilestone: 10 };
  const result = evaluateSignals({ snapshot: snapshot({ settled: 43 }), state, nowIso: NOW_ISO });

  assert.equal(result.quiet, true, "43 settled must not re-announce the 10 milestone");
});

test("crossing several milestones at once announces only the highest", () => {
  const result = evaluateSignals({ snapshot: snapshot({ settled: 600 }), state: {}, nowIso: NOW_ISO });

  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].signalId, "jobs-settled-500");
  assert.equal(result.nextState.highestSettlementMilestone, 500);
});

test("an external-activity claim is vetoed while the public payload says zero", () => {
  // The signal cannot even be built while external is 0, so assert the veto
  // directly against a hand-built candidate — this is the rule that protects
  // the claim, not the rule that builds it.
  const candidate = {
    signalId: "external-agents-first",
    claim: "An agent outside Averray completed work",
    claimsExternalActivity: true,
    restsOn: [readField(snapshot({ external: 0 }), "flow.composition24h.external")]
  };

  const veto = vetoFor(candidate, snapshot({ external: 0 }));

  assert.equal(veto.reason, VETO_REASONS.NO_EXTERNAL_ACTIVITY);
  assert.match(veto.detail, /value 0/u);
});

test("the first external agent fires once the payload actually shows one", () => {
  const result = evaluateSignals({ snapshot: snapshot({ external: 1 }), state: {}, nowIso: NOW_ISO });

  const external = result.fired.find((signal) => signal.signalId === "external-agents-first");
  assert.ok(external, "external-agents-first should fire when the payload reports 1");
  assert.equal(external.checkedAgainst.fields["flow.composition24h.external"].value, 1);
  assert.equal(result.nextState.firedSignals["external-agents-first"].firedAt, NOW_ISO);
});

test("a stale field is never published, even when the threshold is crossed", () => {
  const result = evaluateSignals({
    snapshot: snapshot({ settled: 100, settledStatus: "stale" }),
    state: {},
    nowIso: NOW_ISO
  });

  assert.equal(result.quiet, true);
  assert.equal(result.vetoed.length, 1);
  assert.equal(result.vetoed[0].vetoReason, VETO_REASONS.FIELD_NOT_FRESH);
  assert.match(result.vetoed[0].vetoDetail, /allTime is stale/u);
});

test("an unknown field is treated exactly like a stale one", () => {
  const broken = snapshot({ settled: 100 });
  delete broken.flow.jobsSettled.allTime;

  const result = evaluateSignals({ snapshot: broken, state: {}, nowIso: NOW_ISO });

  assert.equal(result.quiet, true);
});

test("schema drift fails closed and vetoes everything", () => {
  const result = evaluateSignals({
    snapshot: snapshot({ settled: 100, schemaVersion: "averray.transparency.v2" }),
    state: {},
    nowIso: NOW_ISO
  });

  assert.equal(result.quiet, true);
  assert.equal(result.vetoed[0].vetoReason, VETO_REASONS.SCHEMA_DRIFT);
});

test("a vetoed milestone is not consumed and stays eligible", () => {
  const stale = evaluateSignals({
    snapshot: snapshot({ settled: 100, settledStatus: "stale" }),
    state: {},
    nowIso: NOW_ISO
  });
  assert.equal(stale.nextState.highestSettlementMilestone, 0, "a vetoed milestone must not advance state");

  const recovered = evaluateSignals({
    snapshot: snapshot({ settled: 100 }),
    state: stale.nextState,
    nowIso: NOW_ISO
  });
  assert.equal(recovered.fired[0].signalId, "jobs-settled-100");
});

test("every fired signal carries the snapshot it was true against", () => {
  const result = evaluateSignals({ snapshot: snapshot({ settled: 12 }), state: {}, nowIso: NOW_ISO });
  const checked = result.fired[0].checkedAgainst;

  assert.equal(checked.endpoint, "/transparency");
  assert.equal(checked.schemaVersion, EXPECTED_SCHEMA_VERSION);
  assert.equal(checked.generatedAtMs, GENERATED_AT_MS);
  assert.equal(checked.fields["flow.jobsSettled.allTime"].value, 12);
});

test("socialSignalSweep seeds on a missing state file, then announces on the next run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "social-signal-sweep-"));
  const evidenceFile = join(tmp, "evidence.json");
  const stateFile = join(tmp, "state.json");
  const env = {
    TRANSPARENCY_URL: "https://api.example.test/transparency",
    SOCIAL_SWEEP_EVIDENCE_FILE: evidenceFile,
    SOCIAL_SWEEP_STATE_FILE: stateFile
  };
  const respondWith = (settled) => async () => ({
    ok: true,
    status: 200,
    json: async () => snapshot({ settled })
  });
  const run = (settled) =>
    socialSignalSweep({ env, fetchImpl: respondWith(settled), log: () => {}, now: () => new Date(NOW_ISO) });

  const first = await run(12);
  assert.equal(first.firstRun, true);
  assert.equal(first.quiet, true);
  assert.equal(first.seeded[0].signalId, "jobs-settled-10");
  assert.equal(first.observed["flow.composition24h.external"].value, 0);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).highestSettlementMilestone, 10);

  const second = await run(60);
  assert.equal(second.firstRun, false);
  assert.equal(second.fired[0].signalId, "jobs-settled-50");

  const persistedEvidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(persistedEvidence.fired.length, 1);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).highestSettlementMilestone, 50);
});

// --- truth boundary: a broken reader must never render as a quiet day ---

test("a readable payload is live", () => {
  assert.deepEqual(assessPayload(snapshot()), { state: "live", reason: null });
});

test("a 200 carrying a useless body is degraded, not quiet", () => {
  const assessed = assessPayload({});

  assert.equal(assessed.state, "degraded");
  assert.match(assessed.reason, /schema version is absent/u);
});

test("schema drift is degraded at the payload level", () => {
  const assessed = assessPayload(snapshot({ schemaVersion: "averray.transparency.v2" }));

  assert.equal(assessed.state, "degraded");
  assert.match(assessed.reason, /averray\.transparency\.v2/u);
});

test("a right-shaped payload with every dependency missing is degraded", () => {
  const gutted = snapshot();
  delete gutted.flow.jobsSettled.allTime;
  delete gutted.flow.composition24h.external;

  assert.equal(assessPayload(gutted).state, "degraded");
});

test("merely stale fields are live — staleness is a per-signal veto, not a broken reader", () => {
  const stale = snapshot({ settledStatus: "stale", externalStatus: "stale" });

  assert.equal(assessPayload(stale).state, "live");
});

test("a degraded payload throws, writes evidence, and does not touch state", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "social-signal-sweep-degraded-"));
  const evidenceFile = join(tmp, "evidence.json");
  const stateFile = join(tmp, "state.json");
  const original = { firedSignals: {}, highestSettlementMilestone: 50 };
  await writeFile(stateFile, JSON.stringify(original), "utf8");

  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });

  await assert.rejects(
    () =>
      socialSignalSweep({
        env: {
          TRANSPARENCY_URL: "https://api.example.test/transparency",
          SOCIAL_SWEEP_EVIDENCE_FILE: evidenceFile,
          SOCIAL_SWEEP_STATE_FILE: stateFile
        },
        fetchImpl,
        log: () => {},
        now: () => new Date(NOW_ISO)
      }),
    /degraded/u
  );

  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(evidence.payload, "degraded", "evidence must record the degraded state");
  assert.equal(evidence.quiet, false, "a degraded run is never reported as quiet");

  assert.deepEqual(
    JSON.parse(await readFile(stateFile, "utf8")),
    original,
    "an unreadable payload must not be allowed to rewrite announcement history"
  );
});

test("a corrupt state file fails loudly instead of resetting announcement history", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "social-signal-sweep-corrupt-"));
  const stateFile = join(tmp, "state.json");
  await writeFile(stateFile, "{ this is not json", "utf8");

  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => snapshot({ settled: 600 }) });

  await assert.rejects(
    () =>
      socialSignalSweep({
        env: {
          TRANSPARENCY_URL: "https://api.example.test/transparency",
          SOCIAL_SWEEP_EVIDENCE_FILE: join(tmp, "evidence.json"),
          SOCIAL_SWEEP_STATE_FILE: stateFile
        },
        fetchImpl,
        log: () => {},
        now: () => new Date(NOW_ISO)
      }),
    /not valid JSON — refusing to reset it/u
  );

  assert.equal(await readFile(stateFile, "utf8"), "{ this is not json", "the corrupt file is left intact");
});

test("a non-200 transparency read fails loudly instead of reporting quiet", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

  await assert.rejects(
    () => socialSignalSweep({ env: {}, fetchImpl, log: () => {}, now: () => new Date(NOW_ISO) }),
    /responded 503/u
  );
});
