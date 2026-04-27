import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildContentRecord } from "./content-addressed-store.js";
import {
  ContentRecoveryLog,
  createContentRecoveryLog,
  recordFromRecoveryLine,
  replayContentRecoveryLog
} from "./content-recovery-log.js";
import { ConfigError } from "./errors.js";
import { MemoryStateStore } from "./state-store.js";

const OWNER = "0x1111111111111111111111111111111111111111";

test("ContentRecoveryLog appends canonical JSONL entries to the daily file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "averray-content-log-"));
  const recoveryLog = new ContentRecoveryLog({ dir });
  const record = buildContentRecord({
    ownerWallet: OWNER,
    contentType: "arbitrator_reasoning",
    verdict: "fail",
    createdAt: "2026-04-27T12:00:00.000Z",
    payload: { b: 2, a: 1 }
  });

  const result = await recoveryLog.append(record, { loggedAt: "2026-04-27T12:01:00.000Z" });

  assert.equal(result.enabled, true);
  assert.equal(result.hash, record.hash);
  const raw = await readFile(join(dir, "2026-04-27.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.kind, "content.upserted");
  assert.equal(entry.hash, record.hash);
  assert.deepEqual(entry.payload, { a: 1, b: 2 });
});

test("ContentRecoveryLog validates hash before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "averray-content-log-"));
  const recoveryLog = new ContentRecoveryLog({ dir });
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { ok: true }
  });

  await assert.rejects(
    () => recoveryLog.append({ ...record, hash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }),
    /content hash does not match/u
  );
});

test("ContentRecoveryLog disabled mode is a no-op", async () => {
  const recoveryLog = new ContentRecoveryLog({ enabled: false });
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { ok: true }
  });

  assert.deepEqual(await recoveryLog.append(record), { enabled: false });
});

test("createContentRecoveryLog parses boolean env", () => {
  assert.equal(createContentRecoveryLog({ CONTENT_RECOVERY_LOG_ENABLED: "0" }).enabled, false);
  assert.equal(createContentRecoveryLog({ CONTENT_RECOVERY_LOG_ENABLED: "yes" }).enabled, true);
  assert.throws(
    () => createContentRecoveryLog({ CONTENT_RECOVERY_LOG_ENABLED: "sometimes" }),
    ConfigError
  );
});

test("recordFromRecoveryLine validates canonical content hash", () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { ok: true }
  });
  const line = JSON.stringify({
    kind: "content.upserted",
    loggedAt: "2026-04-27T12:01:00.000Z",
    ...record
  });

  assert.deepEqual(recordFromRecoveryLine(line), record);
  assert.throws(
    () => recordFromRecoveryLine(line.replace(record.hash, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")),
    /content hash does not match/u
  );
});

test("replayContentRecoveryLog dry-runs and applies valid entries in file order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "averray-content-replay-"));
  const recoveryLog = new ContentRecoveryLog({ dir });
  const stateStore = new MemoryStateStore();
  const first = buildContentRecord({
    ownerWallet: OWNER,
    payload: { a: 1 },
    contentType: "arbitrator_reasoning",
    verdict: "fail",
    createdAt: "2026-04-27T12:00:00.000Z"
  });
  const published = { ...first, publishedAt: "2026-04-27T13:00:00.000Z" };
  await recoveryLog.append(first, { loggedAt: "2026-04-27T12:01:00.000Z" });
  await recoveryLog.append(published, { loggedAt: "2026-04-27T13:01:00.000Z" });

  const dryRun = await replayContentRecoveryLog({ dir, stateStore });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.filesRead, 1);
  assert.equal(dryRun.recordsSeen, 2);
  assert.equal(dryRun.wouldRestore, 2);
  assert.equal(await stateStore.getContent(first.hash), undefined);

  const applied = await replayContentRecoveryLog({ dir, stateStore, apply: true });
  assert.equal(applied.restored, 2);
  assert.equal((await stateStore.getContent(first.hash)).publishedAt, "2026-04-27T13:00:00.000Z");

  const secondApply = await replayContentRecoveryLog({ dir, stateStore, apply: true });
  assert.equal(secondApply.restored, 0);
  assert.equal(secondApply.skipped, 2);
});

test("replayContentRecoveryLog reports invalid lines without applying them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "averray-content-replay-"));
  const stateStore = new MemoryStateStore();
  await appendFile(join(dir, "2026-04-27.jsonl"), "{\"kind\":\"content.upserted\",\"hash\":\"0xnope\"}\n", "utf8");

  const summary = await replayContentRecoveryLog({
    dir,
    stateStore,
    apply: true,
    logger: { warn() {} }
  });

  assert.equal(summary.recordsSeen, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.restored, 0);
  assert.equal(summary.errors[0].location, "2026-04-27.jsonl:1");
});
