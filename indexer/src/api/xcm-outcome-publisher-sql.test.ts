import assert from "node:assert/strict";
import test from "node:test";

import { buildUpsertExternalOutcomeSql } from "./xcm-outcome-publisher-sql.ts";

const outcome = {
  requestId: `0x${"11".repeat(32)}`,
  status: "succeeded",
  settledAssets: "5",
  settledShares: "7",
  remoteRef: `0x${"22".repeat(32)}`,
  failureCode: null,
  observedAt: "2026-04-23T12:00:00.000Z",
  source: "external_xcm_source"
};

test("external outcome upsert ignores stale observedAt replays", () => {
  const query = buildUpsertExternalOutcomeSql(outcome);
  const text = sqlText(query);

  assert.match(text, /ON CONFLICT \(request_id\) DO UPDATE SET/u);
  assert.match(text, /WHERE xcm_external_outcomes\.observed_at <= EXCLUDED\.observed_at/u);
  assert.deepEqual(sqlParams(query), [
    outcome.requestId,
    outcome.status,
    outcome.settledAssets,
    outcome.settledShares,
    outcome.remoteRef,
    outcome.failureCode,
    outcome.observedAt,
    outcome.source
  ]);
});

test("external outcome upsert keeps dynamic values parameterized", () => {
  const injectedOutcome = {
    ...outcome,
    requestId: `0x${"33".repeat(32)}`,
    status: "succeeded'); DROP TABLE xcm_external_outcomes; --",
    settledAssets: "0); DROP TABLE xcm_external_observer_state; --",
    settledShares: "1",
    remoteRef: "remote'); SELECT current_user; --",
    failureCode: "failure'); DELETE FROM xcm_external_outcomes; --",
    source: "feed'); DROP SCHEMA public; --"
  };
  const query = buildUpsertExternalOutcomeSql(injectedOutcome);
  const text = sqlText(query);

  assert.doesNotMatch(text, /DROP TABLE|DELETE FROM|DROP SCHEMA|current_user/u);
  assert.match(text, /VALUES \(\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?\s*\)/u);
  assert.deepEqual(sqlParams(query), [
    injectedOutcome.requestId,
    injectedOutcome.status,
    injectedOutcome.settledAssets,
    injectedOutcome.settledShares,
    injectedOutcome.remoteRef,
    injectedOutcome.failureCode,
    injectedOutcome.observedAt,
    injectedOutcome.source
  ]);
});

function sqlText(query: { queryChunks: unknown[] }) {
  return query.queryChunks
    .map((chunk) => isStringChunk(chunk) ? chunk.value.join("") : "?")
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function sqlParams(query: { queryChunks: unknown[] }) {
  return query.queryChunks.filter((chunk) => !isStringChunk(chunk));
}

function isStringChunk(chunk: unknown): chunk is { value: string[] } {
  return Boolean(
    chunk &&
    typeof chunk === "object" &&
    Array.isArray((chunk as { value?: unknown }).value)
  );
}
