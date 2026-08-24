export const WORK_RECEIPT_JOB_INDEX_REPAIR_SCOPE = "work-receipt-job-index-repair-v1";
export const WORK_RECEIPT_JOB_INDEX_REPAIR_PAGE_SIZE = 200;
export const WORK_RECEIPT_JOB_INDEX_REPAIR_MAX_DOCUMENTS = 1_000;

/**
 * Incrementally rebuild the lowercase session aliases and job receipt index
 * from immutable receipt documents. One startup processes a bounded slice;
 * the persisted cursor resumes a larger corpus on the next restart.
 */
export async function repairWorkReceiptJobIndex({
  stateStore,
  logger = console,
  now = () => new Date(),
  pageSize = WORK_RECEIPT_JOB_INDEX_REPAIR_PAGE_SIZE,
  maxDocuments = WORK_RECEIPT_JOB_INDEX_REPAIR_MAX_DOCUMENTS
} = {}) {
  if (typeof stateStore?.scanWorkReceiptDocuments !== "function"
      || typeof stateStore?.indexWorkReceiptDocument !== "function") {
    throw new TypeError("Work-receipt job-index repair requires receipt scan and index support.");
  }
  const prior = await stateStore.getServiceState?.(WORK_RECEIPT_JOB_INDEX_REPAIR_SCOPE);
  if (prior?.completed === true) {
    const result = { ...(prior.result ?? {}), completed: true, skipped: true };
    logger.info?.(result, "work_receipt_job_index_repair.already_complete");
    return result;
  }

  const cumulative = {
    documentsScanned: Number(prior?.result?.documentsScanned ?? 0),
    sessionAliasesObserved: Number(prior?.result?.sessionAliasesObserved ?? 0),
    jobCandidates: Number(prior?.result?.jobCandidates ?? 0),
    jobIndexesUpdated: Number(prior?.result?.jobIndexesUpdated ?? 0),
    skippedDocuments: Number(prior?.result?.skippedDocuments ?? 0)
  };
  let cursor = String(prior?.cursor ?? "0");
  let documentsProcessedThisRun = 0;
  let pagesScannedThisRun = 0;
  let completed = false;
  const boundedPageSize = positiveInteger(pageSize, WORK_RECEIPT_JOB_INDEX_REPAIR_PAGE_SIZE);
  const boundedMaximum = positiveInteger(maxDocuments, WORK_RECEIPT_JOB_INDEX_REPAIR_MAX_DOCUMENTS);
  const maxPages = Math.max(1, Math.ceil(boundedMaximum / boundedPageSize) + 10);

  while (!completed
      && documentsProcessedThisRun < boundedMaximum
      && pagesScannedThisRun < maxPages) {
    const page = await stateStore.scanWorkReceiptDocuments({
      cursor,
      limit: Math.min(boundedPageSize, boundedMaximum - documentsProcessedThisRun)
    });
    pagesScannedThisRun += 1;
    for (const document of page.documents ?? []) {
      documentsProcessedThisRun += 1;
      cumulative.documentsScanned += 1;
      const indexed = await stateStore.indexWorkReceiptDocument(document);
      if (indexed?.sessionIndexed) cumulative.sessionAliasesObserved += 1;
      if (document?.jobId) cumulative.jobCandidates += 1;
      else cumulative.skippedDocuments += 1;
      if (indexed?.jobIndexed) cumulative.jobIndexesUpdated += 1;
    }
    cursor = String(page.nextCursor ?? "0");
    completed = cursor === "0";
  }

  const completedAt = completed ? asIso(now()) : undefined;
  await stateStore.upsertServiceState?.(WORK_RECEIPT_JOB_INDEX_REPAIR_SCOPE, {
    version: 1,
    completed,
    cursor,
    ...(completedAt ? { completedAt } : {}),
    result: cumulative
  });
  const result = {
    ...cumulative,
    documentsProcessedThisRun,
    pagesScannedThisRun,
    cursor,
    completed,
    ...(completedAt ? { completedAt } : {}),
    skipped: false
  };
  logger.info?.(
    result,
    completed
      ? "work_receipt_job_index_repair.completed"
      : "work_receipt_job_index_repair.checkpoint"
  );
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Work-receipt index repair clock must be valid.");
  return date.toISOString();
}
