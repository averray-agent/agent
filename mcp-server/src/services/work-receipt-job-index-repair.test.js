import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import {
  WORK_RECEIPT_JOB_INDEX_REPAIR_SCOPE,
  repairWorkReceiptJobIndex
} from "./work-receipt-job-index-repair.js";

function receipt(digit, { outcome, verifiedAt, sessionId, jobId }) {
  return {
    schemaVersion: "averray.work-receipt.v1",
    receiptId: `0x${digit.repeat(64)}`,
    sessionId,
    jobId,
    verdict: { outcome },
    timestamps: { verifiedAt }
  };
}

test("work receipt job-index repair is bounded, resumable, idempotent, and logs its completed counts", async () => {
  const store = new MemoryStateStore();
  const rejected = receipt("1", {
    outcome: "rejected",
    verifiedAt: "2026-08-24T11:00:00.000Z",
    sessionId: "Session-Rejected",
    jobId: "Job-Repair"
  });
  const approved = receipt("2", {
    outcome: "approved",
    verifiedAt: "2026-08-24T10:00:00.000Z",
    sessionId: "Session-Approved",
    jobId: "Job-Repair"
  });
  // Seed only immutable documents, reproducing production before the indexes
  // introduced by this change exist.
  store.workReceiptDocuments.set(rejected.receiptId, rejected);
  store.workReceiptDocuments.set(approved.receiptId, approved);
  const logs = [];
  const logger = { info(fields, message) { logs.push({ fields, message }); } };

  const checkpoint = await repairWorkReceiptJobIndex({
    stateStore: store,
    logger,
    pageSize: 1,
    maxDocuments: 1
  });
  assert.equal(checkpoint.completed, false);
  assert.equal(checkpoint.documentsProcessedThisRun, 1);
  assert.equal(checkpoint.cursor, "1");
  assert.equal(logs[0].message, "work_receipt_job_index_repair.checkpoint");

  const completed = await repairWorkReceiptJobIndex({
    stateStore: store,
    logger,
    pageSize: 1,
    maxDocuments: 1,
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.documentsScanned, 2);
  assert.equal(completed.jobCandidates, 2);
  assert.equal(completed.jobIndexesUpdated, 2);
  assert.equal(completed.completedAt, "2026-08-24T12:00:00.000Z");
  assert.equal(logs[1].message, "work_receipt_job_index_repair.completed");
  assert.equal((await store.getWorkReceiptDocumentByJob("JOB-REPAIR")).receiptId, approved.receiptId);
  assert.equal((await store.getWorkReceiptDocumentBySession("SESSION-APPROVED")).receiptId, approved.receiptId);
  assert.equal((await store.getServiceState(WORK_RECEIPT_JOB_INDEX_REPAIR_SCOPE)).completed, true);

  const replay = await repairWorkReceiptJobIndex({ stateStore: store, logger });
  assert.equal(replay.skipped, true);
  assert.equal(replay.documentsScanned, 2);
  assert.equal(logs[2].message, "work_receipt_job_index_repair.already_complete");
});

test("production bootstrap awaits the bounded work-receipt job-index repair", async () => {
  const source = await readFile(new URL("./bootstrap.js", import.meta.url), "utf8");
  const stateStoreConstruction = source.indexOf("createStateStore(process.env");
  const repairCall = source.indexOf("await repairWorkReceiptJobIndex({ stateStore, logger })");
  const platformConstruction = source.indexOf("new PlatformService(", repairCall);

  assert.ok(repairCall > stateStoreConstruction, "repair must run after the durable store exists");
  assert.ok(platformConstruction > repairCall, "repair must run before routes can resolve aliases");
});
