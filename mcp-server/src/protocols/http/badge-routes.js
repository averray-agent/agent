import { createHash } from "node:crypto";
import { ValidationError, normalizeError } from "../../core/errors.js";
import { buildBadgeSigners } from "../../core/badge-metadata.js";
import { BADGE_RECEIPT_JWKS_PATH } from "../../core/badge-receipt-signing.js";
import { assertWorkReceiptContentAddress } from "../../core/work-receipt.js";
import {
  decorateReceiptPresentation,
  receiptPresentationFields
} from "../../core/verdict-presentation.js";

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
  async function rowsForSessions(sessions) {
    const receipts = [];
    for (const session of sessions) {
      try {
        const storedRunReceipt = await latestReviewedReceipt(await stateStore.getRunReceiptDocument?.(session.sessionId), stateStore);
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
  }

  return async function listBadgeReceipts({ limit = 50, cursor } = {}) {
    const after = decodeBadgeCursor(cursor);
    const rows = [];
    let found = !after;
    // Page session metadata without enriching it or rereading old receipts.
    // The cursor names a row (session + kind), not a shifting array offset.
    for (let offset = 0; ; offset += 100) {
      const sessions = await stateStore.listRecentSessions(100, offset);
      for (const session of sessions) {
        if (!found && session.sessionId !== after.sessionId) continue;
        const receipts = await rowsForSessions([session]);
        for (const row of receipts) {
          if (!found) {
            if (row.sessionId === after.sessionId && row.kind === after.kind) found = true;
            continue;
          }
          rows.push(row);
          if (rows.length > limit) return badgePage(rows, limit);
        }
      }
      if (sessions.length < 100) break;
    }
    if (!found) throw new ValidationError("Badge cursor is no longer available; restart the listing.", "invalid_cursor");
    return badgePage(rows, limit);
  };
}

function decodeBadgeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.v === 1 && typeof value.sessionId === "string" && value.sessionId.length
      && ["run", "badge"].includes(value.kind)) return value;
  } catch { /* Return a named client error, never an opaque parser failure. */ }
  throw new ValidationError("Invalid badge cursor.", "invalid_cursor");
}

function badgePage(rows, limit) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(({ badge, runReceipt, ...unsignedPresentation }) => ({
      schemaVersion: "averray.badge-list-item.v1",
      document: badge ?? runReceipt,
      unsignedPresentation
    })),
    limit,
    nextCursor: rows.length > limit
      ? Buffer.from(JSON.stringify({ v: 1, sessionId: last.sessionId, kind: last.kind })).toString("base64url")
      : null
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
    ...receiptPresentationFields(document),
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
  presentationEnv = process.env,
}) {
  return async function handleBadgeRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === BADGE_RECEIPT_JWKS_PATH) {
      respond(response, 200, badgeReceiptSigner?.getJwks?.() ?? { keys: [] }, {
        "cache-control": "public, max-age=300"
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/badges") {
      const page = await listBadgeReceipts({ limit: parseLimit(url, 50, 500), cursor: url.searchParams.get("cursor") });
      const etag = `W/"${createHash("sha256").update(JSON.stringify(page)).digest("hex")}"`;
      const headers = { etag, "cache-control": "public, max-age=0, must-revalidate" };
      if (page.nextCursor) {
        const next = new URL(url);
        next.searchParams.set("cursor", page.nextCursor);
        headers.link = `<${next.pathname}${next.search}>; rel="next"`;
      }
      const matches = String(request.headers?.["if-none-match"] ?? "").split(",")
        .some((value) => value.trim() === "*" || value.trim().replace(/^W\//u, "") === etag.replace(/^W\//u, ""));
      respond(response, matches ? 304 : 200, matches ? undefined : page, headers);
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/receipts/")) {
      const requestedId = decodeURIComponent(pathname.slice("/receipts/".length)).trim().toLowerCase();
      if (!requestedId) throw new ValidationError("receipt id path segment is required.");

      // Exact content ids always win. This ordering is load-bearing because a
      // chain job id has the same 0x + 64-hex shape as a receipt id.
      const exactReceipt = await stateStore?.getWorkReceiptDocument?.(requestedId);
      if (exactReceipt) {
        assertWorkReceiptContentAddress(exactReceipt);
        respond(response, 200, decorateReceiptPresentation(exactReceipt, { env: presentationEnv }), {
          "cache-control": "public, max-age=31536000, immutable"
        });
        return true;
      }

      const sessionReceipt = await latestReviewedReceipt(await stateStore?.getWorkReceiptDocumentBySession?.(requestedId), stateStore);
      if (sessionReceipt) {
        redirectToCanonicalReceipt(response, sessionReceipt, respond);
        return true;
      }

      const jobReceipt = await latestReviewedReceipt(await stateStore?.getWorkReceiptDocumentByJob?.(requestedId), stateStore);
      if (jobReceipt) {
        redirectToCanonicalReceipt(response, jobReceipt, respond);
        return true;
      }

      respond(response, 404, { status: "not_found", kind: "work", id: requestedId });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/badges/") && pathname.endsWith("/run")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length, -"/run".length));
      if (!sessionId) throw new ValidationError("sessionId path segment is required.");
      const storedRunReceipt = await latestReviewedReceipt(await stateStore?.getRunReceiptDocument?.(sessionId), stateStore);
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

async function latestReviewedReceipt(original, stateStore) {
  if (!original?.receiptId || !original.sessionId) return original;
  const session = await stateStore?.getSession?.(original.sessionId);
  const reviewedId = session?.qualityReview?.receiptId;
  if (!reviewedId || reviewedId === original.receiptId) return original;
  const reviewed = await stateStore.getWorkReceiptDocument(reviewedId);
  if (!reviewed || reviewed.reviewOf !== original.receiptId) throw new Error("quality_review_receipt_binding_mismatch");
  assertWorkReceiptContentAddress(reviewed);
  return reviewed;
}

function redirectToCanonicalReceipt(response, document, respond) {
  assertWorkReceiptContentAddress(document);
  const receiptId = String(document.receiptId).toLowerCase();
  const location = `/receipts/${receiptId}`;
  respond(response, 301, { status: "moved_permanently", receiptId, location }, {
    location,
    "cache-control": "public, max-age=300"
  });
}
