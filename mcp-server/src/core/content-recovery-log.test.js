import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildContentRecord } from "./content-addressed-store.js";
import { ContentRecoveryLog, createContentRecoveryLog } from "./content-recovery-log.js";
import { ConfigError } from "./errors.js";

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
