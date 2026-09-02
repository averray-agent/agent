#!/usr/bin/env node

/**
 * Request a Hermes tester run from this product repo (P8).
 *
 * A building agent here is a REQUESTER of the tester, never a runner. The
 * contract is Discover → Request → (operator) Approve → Run → Report:
 *
 *   1. DISCOVER  GET  /monitor/tester/capabilities   — what flows exist + which
 *                                                       are actually runnable now
 *   2. REQUEST   POST /monitor/testbed-missions/request
 *                     { requesterAgent, targetUrl, goal, reason, mode }
 *                — parks a board-gated `requested` mission (NOT a run)
 *   3. APPROVE   the operator approves on the Hermes board (or a trust policy)
 *   4. RUN       the Hermes testbed runner claims + runs it
 *   5. REPORT    GET  /monitor/testbed-missions/:id    — read the structured
 *                                                        report back (poll)
 *
 * Security boundary (do not weaken):
 *   - request-only: this module exposes no "run", "approve", or "mutate" call.
 *     Every actual run passes the operator approve gate.
 *   - read-only by default: no mutation flag is ever sent; mutation stays
 *     server-enforced (testnet-only per the env binding).
 *
 * The monitor is a separate service (Hermes), not this repo's API — point it at
 * the monitor base URL (HERMES_MONITOR_URL) with the monitor token if set.
 */

import { pathToFileURL } from "node:url";

const CAPABILITIES_PATH = "/monitor/tester/capabilities";
const REQUEST_PATH = "/monitor/testbed-missions/request";
const MISSION_PATH = "/monitor/testbed-missions/";
const VALID_MODES = new Set(["fresh", "memory"]);

export class TesterRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "TesterRequestError";
  }
}

/** 1. DISCOVER — the self-describing capabilities manifest. Read-only GET. */
export async function discoverTesterCapabilities({
  monitorUrl,
  token = undefined,
  fetchImpl = fetch
} = {}) {
  return getJson(monitorUrl, CAPABILITIES_PATH, { token, fetchImpl });
}

/**
 * 2. REQUEST — park a board-gated `requested` mission. This never runs the
 * mission; the operator approves it on the Hermes board. `requesterAgent` and
 * `reason` are mandatory so every request is attributable + justified.
 */
export async function requestTesterRun({
  monitorUrl,
  token = undefined,
  requesterAgent,
  targetUrl,
  goal = undefined,
  reason,
  mode = "fresh",
  fetchImpl = fetch
} = {}) {
  if (!requesterAgent) {
    throw new TesterRequestError("requesterAgent is required — the tester records who asked.");
  }
  if (!reason) {
    throw new TesterRequestError("reason is required — every request must say why.");
  }
  if (!targetUrl) {
    throw new TesterRequestError("targetUrl is required.");
  }
  if (!VALID_MODES.has(mode)) {
    throw new TesterRequestError(`mode must be "fresh" or "memory", got "${mode}".`);
  }
  // Only the request fields the T6 endpoint accepts. No `initialStatus`,
  // `allowTestMutations`, or any run/approve field — the server forces
  // requested + read-only and ignores client-supplied mutation flags.
  return postJson(monitorUrl, REQUEST_PATH, { requesterAgent, targetUrl, goal, reason, mode }, { token, fetchImpl });
}

/**
 * 5. REPORT — read a mission (status + structured report) back by id. Read-only
 * GET; poll this after requesting until the status is terminal.
 */
export async function readTesterReport({
  monitorUrl,
  token = undefined,
  missionId,
  fetchImpl = fetch
} = {}) {
  if (!missionId) {
    throw new TesterRequestError("missionId is required.");
  }
  return getJson(monitorUrl, `${MISSION_PATH}${encodeURIComponent(missionId)}`, { token, fetchImpl });
}

// ── internals ───────────────────────────────────────────────────────

function resolveBase(monitorUrl) {
  const base = (monitorUrl ?? "").trim().replace(/\/+$/u, "");
  if (!base) {
    throw new TesterRequestError("monitorUrl is required (the Hermes monitor base URL).");
  }
  return base;
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function getJson(monitorUrl, path, { token, fetchImpl }) {
  const res = await fetchImpl(`${resolveBase(monitorUrl)}${path}`, {
    method: "GET",
    headers: { accept: "application/json", ...authHeaders(token) }
  });
  return parse(res, path);
}

async function postJson(monitorUrl, path, body, { token, fetchImpl }) {
  const res = await fetchImpl(`${resolveBase(monitorUrl)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...authHeaders(token) },
    body: JSON.stringify(body)
  });
  return parse(res, path);
}

async function parse(res, path) {
  const text = typeof res.text === "function" ? await res.text() : "";
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error || json?.message || `HTTP ${res.status}`;
    throw new TesterRequestError(`Tester request to ${path} failed: ${detail}`);
  }
  return json;
}

// ── CLI demo (discover, then optionally request / read) ─────────────

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--monitor") out.monitorUrl = next();
    else if (arg === "--token") out.token = next();
    else if (arg === "--requester") out.requesterAgent = next();
    else if (arg === "--target") out.targetUrl = next();
    else if (arg === "--goal") out.goal = next();
    else if (arg === "--reason") out.reason = next();
    else if (arg === "--mode") out.mode = next();
    else if (arg === "--report") out.reportId = next();
  }
  return out;
}

function printHelp() {
  console.log(`Request a Hermes tester run (request-only; operator-gated; read-only).

Usage:
  node examples/request-tester-run/index.mjs --monitor <url> [--token <t>] \\
    [--requester <agent> --target <url> --reason <why> [--goal <g>] [--mode fresh|memory]] \\
    [--report <missionId>]

Env: HERMES_MONITOR_URL, HERMES_MONITOR_TOKEN.
Always prints the capabilities manifest. With --target/--reason it also REQUESTS
a run (parks a board-gated card — the operator approves it). With --report it
reads a mission's report back by id.`);
}

export async function runTesterDemo(options) {
  const monitorUrl = options.monitorUrl ?? process.env.HERMES_MONITOR_URL;
  const token = options.token ?? process.env.HERMES_MONITOR_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;

  const capabilities = await discoverTesterCapabilities({ monitorUrl, token, fetchImpl });
  const result = { capabilities };

  if (options.reportId) {
    result.report = await readTesterReport({ monitorUrl, token, missionId: options.reportId, fetchImpl });
  } else if (options.targetUrl && options.reason) {
    result.requested = await requestTesterRun({
      monitorUrl,
      token,
      requesterAgent: options.requesterAgent ?? "averray-agent",
      targetUrl: options.targetUrl,
      goal: options.goal,
      reason: options.reason,
      mode: options.mode ?? "fresh",
      fetchImpl
    });
    result.note = "Requested — the run is board-gated and waits for operator approval before it runs.";
  }
  return result;
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  runTesterDemo(options)
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
