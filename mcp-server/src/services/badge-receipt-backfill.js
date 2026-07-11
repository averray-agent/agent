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
  const result = { scanned, signed, alreadySigned };
  logger.info?.(result, "badge_receipt_signature.backfill_complete");
  return result;
}
