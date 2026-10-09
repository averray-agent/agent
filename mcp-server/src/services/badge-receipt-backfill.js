export async function backfillBadgeReceiptSignatures({ stateStore, signer, logger = console, pageSize = 100 } = {}) {
  if (!signer) return { scanned: 0, signed: 0, alreadySigned: 0 };
  if (typeof stateStore?.listRecentSessions !== "function" || typeof stateStore?.setBadgeDocumentSignature !== "function") {
    throw new Error("Badge receipt signature backfill requires listRecentSessions and setBadgeDocumentSignature state-store methods.");
  }

  let offset = 0;
  let scanned = 0;
  let signed = 0;
  let alreadySigned = 0;
  while (true) {
    const sessions = await stateStore.listRecentSessions(pageSize, offset);
    for (const session of sessions) {
      const document = await stateStore.getBadgeDocument?.(session.sessionId);
      if (!document) continue;
      scanned += 1;
      if (document.signature) {
        if (typeof signer.verifyDocument !== "function" || !signer.verifyDocument(document)) {
          throw new Error(`Stored badge receipt ${session.sessionId} has an invalid signature; refusing startup.`);
        }
        alreadySigned += 1;
        continue;
      }
      const signature = await signer.signDocument(document);
      if (!signer.verifyDocument({ ...document, signature })) {
        throw new Error(`New badge receipt signature for ${session.sessionId} did not verify; refusing startup.`);
      }
      await stateStore.setBadgeDocumentSignature(session.sessionId, signature);
      signed += 1;
    }
    if (sessions.length < pageSize) break;
    offset += sessions.length;
  }
  const verify = await backfillVerifyReceiptSignatures({ stateStore, signer, pageSize });
  const result = { scanned, signed, alreadySigned, verify };
  logger.info?.(result, "badge_receipt_signature.backfill_complete");
  return result;
}

export async function backfillVerifyReceiptSignatures({ stateStore, signer, pageSize = 100 }) {
  const result = { scanned: 0, signed: 0, alreadySigned: 0 };
  let cursor = "0";
  do {
    const page = await stateStore.scanVerificationRuns({ cursor, limit: pageSize });
    for (const run of page.runs) {
      if (!run.receiptId) continue;
      const document = await stateStore.getWorkReceiptDocument(run.receiptId);
      if (!document || document.intent?.specSource !== "verify_request") {
        throw new Error(`Verify run ${run.runId} has no matching work receipt; refusing startup.`);
      }
      result.scanned++;
      if (document.signature) {
        if (!signer.verifyDocument(document)) throw new Error(`Stored Verify receipt ${run.receiptId} has an invalid signature; refusing startup.`);
        result.alreadySigned++;
        continue;
      }
      const signature = await signer.signDocument(document);
      if (!signer.verifyDocument({ ...document, signature })) {
        throw new Error(`New Verify receipt signature for ${run.receiptId} did not verify; refusing startup.`);
      }
      const stored = await stateStore.setWorkReceiptDocumentSignature(run.receiptId, signature, run.runId);
      if (!stored || !signer.verifyDocument(stored)) throw new Error(`Stored Verify receipt ${run.receiptId} did not verify; refusing startup.`);
      result.signed++;
    }
    cursor = String(page.nextCursor);
  } while (cursor !== "0");
  return result;
}
