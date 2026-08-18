import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { backfillWorkReceipts } from "./work-receipt-backfill.js";

test("work receipt backfill creates only evidence-complete settled rows and reports gaps", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "settled-complete",
    jobId: "job-complete",
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "resolved",
    updatedAt: "2026-08-18T10:00:00.000Z",
    jobSnapshot: { version: "job-snapshot-v1", definition: { id: "job-complete" } }
  });
  await stateStore.upsertSession({
    sessionId: "settled-missing-evidence",
    jobId: "job-missing",
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "rejected",
    updatedAt: "2026-08-18T10:01:00.000Z"
  });
  await stateStore.upsertVerificationResult("settled-complete", { outcome: "approved" });
  const calls = [];
  const result = await backfillWorkReceipts({
    stateStore,
    verificationIngestionService: {
      resolveJob: () => ({ id: "job-complete" }),
      async persistRunReceiptDocument(session) {
        calls.push(session.sessionId);
        return { receiptId: `0x${"1".repeat(64)}` };
      }
    },
    logger: { info() {} },
    pageSize: 1
  });

  assert.deepEqual(calls, ["settled-complete"]);
  assert.deepEqual(result, {
    scanned: 2,
    created: 1,
    existing: 0,
    skipped: 1,
    failures: []
  });
});
