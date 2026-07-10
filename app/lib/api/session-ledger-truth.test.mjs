import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { feedPresence } from "./feed-presence.js";
import { buildSessionFilterOptions } from "../ui/session-ledger.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const sessionsDir = resolve(appRoot, "components", "sessions");
const page = readFileSync(resolve(appRoot, "app", "(authed)", "sessions", "page.tsx"), "utf8");
const aggregate = readFileSync(resolve(sessionsDir, "SessionsAggregateStrip.tsx"), "utf8");
const table = readFileSync(resolve(sessionsDir, "SessionsTable.tsx"), "utf8");
const topbar = readFileSync(resolve(sessionsDir, "SessionsTopbar.tsx"), "utf8");
const adapter = readFileSync(resolve(here, "session-adapters.ts"), "utf8");

test("locked admin sessions stay locked throughout the sessions surface", () => {
  assert.equal(feedPresence({ error: { status: 403 } }), "locked");
  assert.match(page, /sessionsPresence\s*=\s*feedPresence\(sessionsQuery\)/u);
  assert.match(page, /<SessionsAggregateStrip[\s\S]*presence=\{sessionsPresence\}/u);
  assert.match(page, /<SessionsTable[\s\S]*presence=\{sessionsPresence\}/u);
  assert.match(aggregate, /session feed locked for this session \(no operator role\)/u);
  assert.match(table, /Session ledger locked for this session/u);
  assert.doesNotMatch(adapter, /claimedJobSession|liveSessionRows/u);
});

test("session filter chips are derived only from emitted row values", () => {
  assert.deepEqual(
    buildSessionFilterOptions([
      { state: "resolved", escrow: { asset: "USDC" }, verifierMode: "benchmark" },
      { state: "claimed", escrow: { asset: "USDC" }, verifierMode: "github_pr" },
      { state: "claimed", escrow: { asset: "USDC" }, verifierMode: "benchmark" },
    ]),
    {
      states: ["claimed", "resolved"],
      assets: ["USDC"],
      verifiers: ["benchmark", "github_pr"],
    }
  );
  assert.deepEqual(buildSessionFilterOptions([]), {
    states: [],
    assets: [],
    verifiers: [],
  });
});

test("session adapters fail closed for missing state, asset, and verifier fields", () => {
  assert.match(adapter, /return "unknown"/u);
  assert.match(adapter, /"asset n\/a"/u);
  assert.match(adapter, /"not emitted"/u);
  assert.doesNotMatch(adapter, /text\(value, "DOT"\)|return "semantic"|return "active"/u);
  assert.doesNotMatch(adapter, /text\(session\.status, "claimed"\)/u);
});

test("sessions components contain no fabricated filter vocabularies", () => {
  const source = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => readFileSync(resolve(sessionsDir, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /vDOT|paired-hash|human-llm|semantic/u);
});

test("sessions export is wired and anomaly flagging is removed", () => {
  assert.match(page, /buildSessionManifestPayload\(filtered\)/u);
  assert.match(page, /verifyManifestEnvelope\(manifest\)/u);
  assert.match(topbar, /onClick=\{onExportAuditBundle\}/u);
  assert.doesNotMatch(topbar, /Flag anomaly/u);
});
