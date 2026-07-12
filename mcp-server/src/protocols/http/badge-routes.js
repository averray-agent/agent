import { ValidationError, normalizeError } from "../../core/errors.js";
import { buildBadgeSigners } from "../../core/badge-metadata.js";
import { BADGE_RECEIPT_JWKS_PATH } from "../../core/badge-receipt-signing.js";

export function createListBadgeReceipts({
  buildBadgeFromSession,
  badgeReceiptSigner,
  deriveBadgeLineage,
  publicBaseUrl,
  posterAddress,
  service,
  stateStore,
  verifierAddress,
  verifierService
}) {
  return async function listBadgeReceipts(limit = 100) {
    const sessions = await service.listRecentSessions(limit);
    const receipts = [];
    for (const session of sessions) {
      try {
        const storedRunReceipt = await stateStore.getRunReceiptDocument?.(session.sessionId);
        if (storedRunReceipt) receipts.push(buildRunReceiptRow(storedRunReceipt, { session }));
      } catch {
        // Run and badge rows are isolated: one malformed document must not
        // suppress the other receipt for an approved session.
      }

      try {
        const storedBadge = await stateStore.getBadgeDocument?.(session.sessionId);
        if (storedBadge) {
          receipts.push(buildBadgeReceipt(storedBadge, { session }));
          continue;
        }

        const verification = await verifierService.getResult(session.sessionId);
        let job;
        try {
          job = service.getJobDefinition(session.jobId);
        } catch {
          job = undefined;
        }
        const context = {
          publicBaseUrl,
          posterAddress,
          verifierAddress,
          lineage: deriveBadgeLineage(session, job)
        };
        const rebuiltBadge = buildBadgeFromSession({ session, job, verification, context });
        const signedBadge = await signBadgeDocument(rebuiltBadge, badgeReceiptSigner);
        const badge = await stateStore.putBadgeDocument?.(session.sessionId, signedBadge) ?? signedBadge;
        receipts.push(buildBadgeReceipt(badge, { session, verification, context }));
      } catch {
        // One stale or malformed row must never take down the public listing.
        continue;
      }
    }
    return receipts;
  };
}

function buildBadgeReceipt(badge, { session, verification, context } = {}) {
  const averray = badge.averray ?? {};
  const signers = Array.isArray(badge.signers) && badge.signers.length > 0
    ? badge.signers
    : buildBadgeSigners({ session, verification, context });
  return {
    sessionId: averray.sessionId ?? session?.sessionId,
    jobId: averray.jobId ?? session?.jobId,
    worker: averray.worker ?? session?.wallet,
    kind: "badge",
    issuedAt: averray.completedAt ?? session?.resolvedAt ?? session?.updatedAt,
    signers,
    evidenceHash: averray.evidenceHash,
    blockRef: averray.chainJobId,
    ...(badge.signature ? { signature: badge.signature } : {}),
    badge
  };
}

function buildRunReceiptRow(document, { session } = {}) {
  const verdict = document.verdict ?? {};
  const timestamps = document.timestamps ?? {};
  return {
    sessionId: document.sessionId ?? session?.sessionId,
    jobId: document.jobId ?? session?.jobId,
    worker: document.worker ?? session?.wallet,
    kind: "run",
    issuedAt: timestamps.verifiedAt ?? session?.resolvedAt ?? session?.rejectedAt ?? session?.updatedAt,
    outcome: verdict.outcome,
    verdict: verdict.outcome,
    reasonCode: verdict.reasonCode,
    signers: Array.isArray(document.signers) ? document.signers : [],
    evidenceHash: verdict.evidenceHash,
    policy: verdict.policyTags?.[0],
    policyTags: Array.isArray(verdict.policyTags) ? verdict.policyTags : [],
    blockRef: document.chainJobId,
    canonicalUrl: document.canonicalUrl,
    ...(document.signature ? { signature: document.signature } : {}),
    runReceipt: document
  };
}

async function signBadgeDocument(badge, signer) {
  if (!signer) return badge;
  return { ...badge, signature: await signer.signDocument(badge) };
}

export function createBadgeRoutes({
  badgeReceiptSigner,
  buildBadgeFromSession,
  deriveBadgeLineage,
  listBadgeReceipts,
  parseLimit,
  publicBaseUrl,
  posterAddress,
  respond,
  service,
  stateStore,
  verifierAddress,
  verifierService,
}) {
  return async function handleBadgeRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === BADGE_RECEIPT_JWKS_PATH) {
      respond(response, 200, badgeReceiptSigner?.getJwks?.() ?? { keys: [] }, {
        "cache-control": "public, max-age=300"
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/badges") {
      respond(response, 200, await listBadgeReceipts(parseLimit(url, 100, 500)), {
        "cache-control": "public, max-age=30"
      });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/badges/") && pathname.endsWith("/run")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length, -"/run".length));
      if (!sessionId) throw new ValidationError("sessionId path segment is required.");
      const storedRunReceipt = await stateStore?.getRunReceiptDocument?.(sessionId);
      if (!storedRunReceipt) {
        respond(response, 404, { status: "not_found", kind: "run", sessionId });
        return true;
      }
      respond(response, 200, storedRunReceipt, { "cache-control": "public, max-age=60" });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/badges/")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length));
      if (!sessionId) {
        throw new ValidationError("sessionId path segment is required.");
      }

      const storedBadge = await stateStore?.getBadgeDocument?.(sessionId);
      if (storedBadge) {
        respond(response, 200, storedBadge, { "cache-control": "public, max-age=60" });
        return true;
      }

      let session;
      try {
        session = await service.resumeSession(sessionId);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          respond(response, 404, { status: "not_found", sessionId });
          return true;
        }
        throw normalized;
      }

      try {
        const verification = await verifierService.getResult(sessionId);
        let job;
        try {
          job = service.getJobDefinition(session.jobId);
        } catch {
          job = undefined;
        }
        const rebuiltBadge = buildBadgeFromSession({
          session,
          job,
          verification,
          context: {
            publicBaseUrl,
            posterAddress,
            verifierAddress,
            lineage: deriveBadgeLineage(session, job)
          }
        });
        const signedBadge = await signBadgeDocument(rebuiltBadge, badgeReceiptSigner);
        const badge = await stateStore?.putBadgeDocument?.(sessionId, signedBadge) ?? signedBadge;
        // Badge JSON is deterministic once a session is resolved.
        respond(response, 200, badge, { "cache-control": "public, max-age=60" });
        return true;
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "badge_not_ready") {
          respond(response, 404, { status: "not_ready", sessionId, reason: normalized.message });
          return true;
        }
        throw normalized;
      }
    }

    return false;
  };
}
