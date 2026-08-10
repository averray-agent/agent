#!/usr/bin/env node
/**
 * Social signal sweep — step 1 of the social signal agent.
 *
 * Reads the public `/transparency` payload, decides whether anything happened
 * that is worth saying out loud, and writes the answer to an evidence file.
 *
 * This script deliberately does **not** draft posts and does **not** publish
 * anything. Threshold evaluation and the truth-boundary veto are arithmetic,
 * not judgment, so they live here as a deterministic step rather than inside a
 * Hermes prompt. Drafting is a language task and belongs to Hermes later; the
 * veto must never be an LLM's opinion.
 *
 * The veto is the point. `/transparency` is what a reader would check to
 * falsify one of our claims, so it is what we check first. A claim the payload
 * contradicts — or a claim resting on a field the payload itself marks stale or
 * unknown — is killed here and never reaches a human queue.
 *
 * See docs/PACKET_SOCIAL_SIGNAL_AGENT.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_SHIPPED_LABEL,
  assessGitHub,
  buildShippedCandidates,
  fetchShippedPullRequests
} from "./social-shipped-signals.mjs";
import { queueFiredSignals } from "./social-signal-queue.mjs";

const DEFAULT_TRANSPARENCY_URL = "https://api.averray.com/transparency";
const DEFAULT_EVIDENCE_FILE = "artifacts/social-signal-sweep.json";
const DEFAULT_STATE_FILE = "artifacts/social-signal-state.json";

/** The schema this sweep knows how to read. Anything else fails closed. */
export const EXPECTED_SCHEMA_VERSION = "averray.transparency.v1";

/**
 * Settlement counts worth remarking on. Crossings only — never "we are at 43".
 * A milestone that has fired never fires again.
 */
export const SETTLEMENT_MILESTONES = Object.freeze([10, 50, 100, 500, 1000, 5000, 10_000]);

export const VETO_REASONS = Object.freeze({
  SCHEMA_DRIFT: "schema-drift",
  FIELD_NOT_FRESH: "field-not-fresh",
  NO_EXTERNAL_ACTIVITY: "no-external-activity"
});

/** Fields the sweep cannot function without. */
const REQUIRED_FIELDS = Object.freeze([
  "flow.jobsSettled.allTime",
  "flow.composition24h.external"
]);

/**
 * Is this payload readable at all?
 *
 * Without this check a 200 carrying a useless body produces zero candidates,
 * zero vetoes and `quiet: true` — byte-identical to a genuinely quiet day. That
 * conflates "nothing happened" with "the reader is broken", and the broken case
 * would be reported as the correct outcome. The two must never render the same.
 */
export function assessPayload(snapshot) {
  if (snapshot?.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    return {
      state: "degraded",
      reason: `schema version is ${snapshot?.schemaVersion ?? "absent"}, expected ${EXPECTED_SCHEMA_VERSION}`
    };
  }

  // Individually stale or unknown fields are a per-signal veto, not a broken
  // payload — the veto already handles those and says so. Every dependency
  // missing at once means the branch is not there to read.
  const missing = REQUIRED_FIELDS.filter((path) => readField(snapshot, path).status === "unknown");
  if (missing.length === REQUIRED_FIELDS.length) {
    return { state: "degraded", reason: `no readable fields: ${missing.join(", ")}` };
  }

  return { state: "live", reason: null };
}

/**
 * Pull a `/transparency` field, tolerating a missing branch rather than
 * throwing. A field that is absent reads as `unknown`, which the veto rejects
 * for the same reason it rejects a stale one.
 */
export function readField(snapshot, path) {
  const field = path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), snapshot);
  if (field == null || typeof field !== "object") {
    return { value: null, status: "unknown", readAtMs: null, source: "unavailable", path };
  }
  return {
    value: field.value ?? null,
    status: field.status ?? "unknown",
    readAtMs: Number.isFinite(field.readAtMs) ? field.readAtMs : null,
    source: field.source ?? "unknown",
    path
  };
}

/**
 * Candidate signals, before any veto. Each carries the exact field it rests on
 * so the veto can check that field rather than trust the claim's wording.
 */
export function buildCandidates({ snapshot, state }) {
  const candidates = [];

  const external = readField(snapshot, "flow.composition24h.external");
  if (!state.firedSignals?.["external-agents-first"] && numeric(external.value) >= 1) {
    candidates.push({
      signalId: "external-agents-first",
      source: "transparency",
      claim: `An agent outside Averray completed work in the last 24h (${numeric(external.value)} in the window)`,
      claimsExternalActivity: true,
      restsOn: [external],
      receipt: { kind: "transparency", url: "https://averray.com/transparency" },
      oneShot: true
    });
  }

  const settled = readField(snapshot, "flow.jobsSettled.allTime");
  const settledValue = numeric(settled.value);
  const alreadyCrossed = numeric(state.highestSettlementMilestone);
  const milestone = highestMilestoneCrossed(settledValue, alreadyCrossed);
  if (milestone !== null) {
    candidates.push({
      signalId: `jobs-settled-${milestone}`,
      source: "transparency",
      // "passed N", never "N have settled" — the live count is almost always
      // above the milestone by the time a sweep sees it, and a claim of exactly
      // N would be false against the very field it rests on.
      claim: `Averray mainnet has passed ${milestone} settled jobs`,
      claimsExternalActivity: false,
      restsOn: [settled],
      receipt: { kind: "transparency", url: "https://averray.com/transparency" },
      milestone
    });
  }

  return candidates;
}

/**
 * The truth boundary, mechanized. Returns the veto reason, or `null` to pass.
 */
export function vetoFor(candidate, snapshot) {
  // A signal that does not rest on the transparency payload is not judged by
  // the transparency payload's health. Vetoing a merged pull request because
  // an unrelated endpoint went stale would be a false negative dressed up as
  // caution.
  if (candidate.source && candidate.source !== "transparency") return null;

  if (snapshot?.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    return {
      reason: VETO_REASONS.SCHEMA_DRIFT,
      detail: `expected ${EXPECTED_SCHEMA_VERSION}, payload says ${snapshot?.schemaVersion ?? "nothing"}`
    };
  }

  // A number the transparency service will not vouch for is a number we do not
  // publish. `stale` and `unknown` both fail — the service already decided it
  // could not stand behind the reading, and this surface does not get to
  // overrule that.
  const unusable = candidate.restsOn.find((field) => field.status !== "fresh");
  if (unusable) {
    return {
      reason: VETO_REASONS.FIELD_NOT_FRESH,
      detail: `${unusable.path} is ${unusable.status}`
    };
  }

  // The specific trap this exists for: `composition24h.external` is publicly
  // readable and currently 0. Any claim that outsiders are working is false and
  // trivially falsifiable by a reader hitting the same endpoint.
  if (candidate.claimsExternalActivity) {
    const external = readField(snapshot, "flow.composition24h.external");
    if (external.status !== "fresh" || numeric(external.value) < 1) {
      return {
        reason: VETO_REASONS.NO_EXTERNAL_ACTIVITY,
        detail: `flow.composition24h.external is ${external.status} with value ${external.value ?? "null"}`
      };
    }
  }

  return null;
}

/**
 * Evaluate the payload against stored state. Pure — no clock, no network, no
 * filesystem — so the whole decision surface is testable.
 */
export function evaluateSignals({
  snapshot,
  state = {},
  nowIso,
  firstRun = false,
  extraCandidates = []
}) {
  // Transparency candidates are only built when the payload is readable; the
  // caller decides that. Extra candidates come from other sources and are
  // judged on their own terms — see vetoFor.
  const candidates = [...buildCandidates({ snapshot, state }), ...extraCandidates];
  const fired = [];
  const vetoed = [];
  const seeded = [];

  for (const candidate of candidates) {
    const veto = vetoFor(candidate, snapshot);
    const record = {
      signalId: candidate.signalId,
      claim: candidate.claim,
      receipt: candidate.receipt,
      source: candidate.source ?? "transparency",
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.deployVerified === false ? { deployVerified: false } : {}),
      checkedAgainst:
        (candidate.source ?? "transparency") === "transparency"
          ? {
              endpoint: "/transparency",
              schemaVersion: snapshot?.schemaVersion ?? null,
              generatedAtMs: snapshot?.generatedAtMs ?? null,
              fields: Object.fromEntries(
                candidate.restsOn.map((field) => [
                  field.path,
                  { value: field.value, status: field.status }
                ])
              )
            }
          : { source: candidate.source, receipt: candidate.receipt }
    };

    if (veto) {
      vetoed.push({ ...record, vetoReason: veto.reason, vetoDetail: veto.detail });
      continue;
    }

    // A cold start has no memory, so every already-crossed threshold looks new.
    // Announcing them would mean day one opens with months-old news presented as
    // fresh. The first sweep calibrates instead: state advances, nothing is
    // announced, and the seeded list stays visible so a human can decide whether
    // any of it is still worth saying by hand.
    // `seedOnly` lets a source seed independently of the transparency-side
    // firstRun: the shipped-PR watermark can be absent long after the sweep
    // itself has been running.
    (firstRun || candidate.seedOnly ? seeded : fired).push(record);
  }

  // State advances for anything that passed the veto, whether it was announced
  // or merely seeded. A vetoed milestone is not consumed — it stays eligible for
  // the day the field goes fresh.
  const nextState = {
    // Underscore keys are human annotations on the committed state file. Carry
    // them through so rewriting state does not strip the note explaining it.
    ...Object.fromEntries(Object.entries(state).filter(([key]) => key.startsWith("_"))),
    firedSignals: { ...(state.firedSignals ?? {}) },
    highestSettlementMilestone: numeric(state.highestSettlementMilestone)
  };
  for (const signal of [...fired, ...seeded]) {
    nextState.firedSignals[signal.signalId] = { firedAt: nowIso, seeded: firstRun };
    const candidate = candidates.find((entry) => entry.signalId === signal.signalId);
    if (candidate?.milestone) {
      nextState.highestSettlementMilestone = Math.max(
        nextState.highestSettlementMilestone,
        candidate.milestone
      );
    }
  }

  return { fired, vetoed, seeded, nextState, quiet: fired.length === 0 };
}

export async function socialSignalSweep({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  now = () => new Date()
} = {}) {
  const url = env.TRANSPARENCY_URL || DEFAULT_TRANSPARENCY_URL;
  const evidenceFile = env.SOCIAL_SWEEP_EVIDENCE_FILE || DEFAULT_EVIDENCE_FILE;
  const stateFile = env.SOCIAL_SWEEP_STATE_FILE || DEFAULT_STATE_FILE;
  const nowIso = now().toISOString();

  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  const snapshot = await response.json();
  const { state, firstRun } = await readState(stateFile);
  const payload = assessPayload(snapshot);

  // The two sources are independent, and their health must be too. A stale
  // transparency payload says nothing about whether a pull request merged, so
  // it must not suppress a shipped signal — that would be a false negative
  // wearing caution as a disguise.
  const github = assessGitHub({ env });
  let shipped = { candidates: [], nextShippedSeededAt: state.shippedSeededAt ?? null, seeding: false };
  if (github.state === "live") {
    const pulls = await fetchShippedPullRequests({
      fetchImpl,
      token: env.GITHUB_TOKEN,
      repo: env.GITHUB_REPOSITORY,
      label: env.SOCIAL_SWEEP_LABEL || DEFAULT_SHIPPED_LABEL
    });
    shipped = buildShippedCandidates({ pulls, state, nowIso });
  }

  // A degraded payload evaluates no TRANSPARENCY signals. Reading figures out of
  // a body we have already decided we cannot parse would be inventing findings —
  // but the shipped candidates do not come from that body.
  const { fired, vetoed, seeded, nextState } = evaluateSignals({
    snapshot: payload.state === "live" ? snapshot : null,
    state,
    nowIso,
    firstRun,
    extraCandidates: shipped.candidates
  });
  if (shipped.nextShippedSeededAt) nextState.shippedSeededAt = shipped.nextShippedSeededAt;

  // `quiet` means "we looked everywhere we were meant to and there is nothing to
  // say". An empty result from a source we could not read is not that, so a
  // degraded source disqualifies quiet outright — otherwise a broken reader
  // reports the same word as a calm day, which is the whole failure this sweep
  // was built to avoid. `skipped` is fine: a source that is switched off was
  // never going to be looked at.
  const quiet = fired.length === 0 && payload.state === "live" && github.state !== "degraded";

  const evidence = {
    sweptAt: nowIso,
    endpoint: url,
    schemaVersion: snapshot?.schemaVersion ?? null,
    // "live" or "degraded" — never inferred from an empty result set.
    payload: payload.state,
    payloadReason: payload.reason,
    // Same rule for the second source: "skipped" (not configured) and
    // "degraded" (configured, unreadable) are different states, and neither is
    // "nothing shipped today".
    github: github.state,
    githubReason: github.reason,
    firstRun,
    quiet,
    fired,
    vetoed,
    seeded,
    // Recorded so a reader can tell "nothing happened" apart from "the reader
    // was broken" without re-running the sweep.
    observed: {
      "flow.jobsSettled.allTime": readField(snapshot, "flow.jobsSettled.allTime"),
      "flow.composition24h.external": readField(snapshot, "flow.composition24h.external"),
      "chain.head": readField(snapshot, "chain.head")
    }
  };

  // Evidence is written before the degraded throw so the artifact still carries
  // the reason the run failed.
  await writeJson(evidenceFile, evidence);

  if (payload.state !== "live") {
    log(`social-signal-sweep: DEGRADED — ${payload.reason}`);
    // State is deliberately not advanced: a payload we could not read must not
    // be allowed to rewrite what we believe we have already announced.
    //
    // Accepted consequence: a shipped-PR signal that fired during a transparency
    // outage will fire again on the next healthy sweep, because its watermark was
    // not saved either. A visible repeat is the cheaper mistake — nothing
    // publishes on its own, and the alternative is partial state writes whose
    // correctness depends on which source failed.
    throw new Error(`transparency payload is degraded — ${payload.reason}`);
  }

  await writeJson(stateFile, nextState);

  // A fired signal that exists only in an artifact has reached nobody. The queue
  // turns it into an issue slack-operator can read and put in front of a human.
  //
  // Deliberately after the state write and the degraded throw: we queue only what
  // a healthy run actually stands behind. Idempotency lives in the queue, which
  // matters because CI never persists state — the same signal re-fires daily
  // until a human commits the bump.
  const queue = await queueFiredSignals({
    fetchImpl,
    env,
    signals: fired,
    sweptAt: nowIso,
    observed: evidence.observed,
    log
  });
  evidence.queue = queue.state;
  evidence.queued = queue.queued;
  evidence.queueSkipped = queue.skipped;
  await writeJson(evidenceFile, evidence);

  if (github.state !== "live") log(`social-signal-sweep: shipped signals ${github.state} — ${github.reason}`);
  if (firstRun || shipped.seeding) {
    log(`social-signal-sweep: calibrating — announced nothing (${seeded.length} seeded)`);
  } else if (quiet) {
    log(`social-signal-sweep: quiet — nothing to say (${vetoed.length} vetoed)`);
  } else {
    log(`social-signal-sweep: ${fired.length} fired, ${vetoed.length} vetoed`);
  }
  for (const signal of fired) log(`  fired  ${signal.signalId} — ${signal.claim}`);
  for (const signal of seeded) log(`  seeded ${signal.signalId} — ${signal.claim}`);
  for (const signal of vetoed) log(`  vetoed ${signal.signalId} — ${signal.vetoReason}: ${signal.vetoDetail}`);

  return evidence;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function highestMilestoneCrossed(settled, alreadyCrossed) {
  const crossed = SETTLEMENT_MILESTONES.filter(
    (milestone) => settled >= milestone && milestone > alreadyCrossed
  );
  return crossed.length ? Math.max(...crossed) : null;
}

async function readState(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // Only a genuinely absent file is a first run. Catching every error here
    // would make a corrupt or unreadable state file look like a fresh start —
    // and a fresh start silently overwrites the record of what has already been
    // announced. Permissions, an I/O error, a directory in the way: all loud.
    if (error?.code !== "ENOENT") throw error;
    return { state: { firedSignals: {}, highestSettlementMilestone: 0 }, firstRun: true };
  }

  try {
    return { state: JSON.parse(raw), firstRun: false };
  } catch (error) {
    throw new Error(`state file ${path} is not valid JSON — refusing to reset it: ${error.message}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  socialSignalSweep().catch((error) => {
    console.error(error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
  });
}
