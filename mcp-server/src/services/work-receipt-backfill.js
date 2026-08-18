import { WORK_RECEIPT_SCHEMA_VERSION } from "../core/work-receipt.js";

/**
 * Best-effort migration for historical settled rows. Missing claim-time
 * evidence is reported and skipped; it is never invented to inflate coverage.
 */
export async function backfillWorkReceipts({
  stateStore,
  verificationIngestionService,
  logger = console,
  pageSize = 100
} = {}) {
  if (typeof stateStore?.listRecentSessions !== "function") {
    throw new Error("Work receipt backfill requires listRecentSessions.");
  }
  let offset = 0;
  const result = { scanned: 0, created: 0, existing: 0, skipped: 0, failures: [] };
  while (true) {
    const sessions = await stateStore.listRecentSessions(pageSize, offset);
    for (const session of sessions) {
      if (!["resolved", "rejected"].includes(session?.status)) continue;
      result.scanned += 1;
      const current = await stateStore.getRunReceiptDocument?.(session.sessionId);
      if (current?.schemaVersion === WORK_RECEIPT_SCHEMA_VERSION) {
        result.existing += 1;
        continue;
      }
      const verification = await stateStore.getVerificationResult?.(session.sessionId);
      if (!verification || !session.jobSnapshot) {
        result.skipped += 1;
        continue;
      }
      try {
        const job = verificationIngestionService.resolveJob(session, verification);
        const document = await verificationIngestionService.persistRunReceiptDocument(session, job, verification);
        if (document?.receiptId) result.created += 1;
        else result.skipped += 1;
      } catch (error) {
        result.skipped += 1;
        result.failures.push({ sessionId: session.sessionId, reason: error?.message ?? String(error) });
      }
    }
    if (sessions.length < pageSize) break;
    offset += sessions.length;
  }
  logger.info?.(result, "work_receipt.backfill_complete");
  return result;
}
