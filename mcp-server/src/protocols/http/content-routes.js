import { AuthenticationError, AuthorizationError } from "../../core/errors.js";
import { publicContentUri as buildPublicContentUri } from "../../core/dispute-resolution.js";
import {
  assertContentHashMatches,
  buildContentRecord,
  contentResponse,
  normalizeContentHash,
  publishContentRecord,
  publicContentHeaders,
  requireContentAccess,
  resolveContentAccess,
  shouldAutoDiscloseContent,
} from "../../core/content-addressed-store.js";

export function createContentRoutes({
  authMiddleware,
  gateway,
  hasRole,
  logger,
  persistContentRecord,
  publicBaseUrl,
  readJsonBody,
  respond,
  stateStore,
  walletsMatch,
}) {
  async function optionalAuth(request, url) {
    try {
      return await authMiddleware(request, url, { allowQueryToken: true });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return undefined;
      }
      throw error;
    }
  }

  function publicContentUri(hash) {
    return buildPublicContentUri(hash, { publicBaseUrl });
  }

  async function emitDisclosureEvent(hash, byWallet) {
    if (!gateway?.isEnabled?.() || typeof gateway.discloseContent !== "function") {
      return { emitted: false, reason: "blockchain_disabled" };
    }
    try {
      return { emitted: true, ...(await gateway.discloseContent(hash, byWallet)) };
    } catch (error) {
      logger.warn?.({ err: error, hash, byWallet }, "content.disclosure_event_failed");
      return { emitted: false, reason: "chain_write_failed", error: error?.message ?? "unknown_error" };
    }
  }

  async function maybeEmitAutoDisclosureEvent(record, { now = new Date() } = {}) {
    if (!shouldAutoDiscloseContent(record, { now })) {
      return { emitted: false, reason: "not_auto_public" };
    }
    if (!gateway?.isEnabled?.() || typeof gateway.autoDiscloseContent !== "function") {
      return { emitted: false, reason: "blockchain_disabled" };
    }
    try {
      const result = await gateway.autoDiscloseContent(record.hash);
      return {
        emitted: !result?.skipped,
        ...result
      };
    } catch (error) {
      logger.warn?.({ err: error, hash: record.hash }, "content.auto_disclosure_event_failed");
      return { emitted: false, reason: "chain_write_failed", error: error?.message ?? "unknown_error" };
    }
  }

  return async function handleContentRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/content") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const ownerWallet = typeof payload?.ownerWallet === "string" && payload.ownerWallet.trim()
        ? payload.ownerWallet.trim()
        : auth.wallet;
      if (!walletsMatch(ownerWallet, auth.wallet) && !hasRole(auth.claims, "admin")) {
        throw new AuthorizationError("Only admins can store content for another owner wallet.", "content_owner_forbidden");
      }
      const record = buildContentRecord({
        payload: payload?.payload,
        contentType: payload?.contentType,
        ownerWallet,
        verdict: payload?.verdict,
        publishedAt: payload?.published === true ? new Date().toISOString() : payload?.publishedAt,
        autoPublicAt: payload?.autoPublicAt
      });
      if (payload?.hash !== undefined) {
        assertContentHashMatches({ hash: payload.hash, payload: payload.payload });
      }
      await persistContentRecord(record);
      const access = resolveContentAccess(record, auth);
      respond(response, 201, {
        ...contentResponse(record, access),
        contentURI: publicContentUri(record.hash)
      });
      return true;
    }

    if (request.method === "POST" && /^\/content\/[^/]+\/publish$/u.test(pathname)) {
      const auth = await authMiddleware(request, url);
      const hash = normalizeContentHash(decodeURIComponent(pathname.slice("/content/".length, -"/publish".length)));
      const record = await stateStore.getContent?.(hash);
      if (!record) {
        respond(response, 404, { status: "not_found", hash });
        return true;
      }
      if (!walletsMatch(record.ownerWallet, auth.wallet) && !hasRole(auth.claims, "admin")) {
        throw new AuthorizationError("Only the owner wallet or an admin can publish this content.", "content_publish_forbidden");
      }
      const wasPublished = Boolean(record.publishedAt);
      const published = publishContentRecord(record);
      await persistContentRecord(published);
      const disclosureEvent = wasPublished
        ? { emitted: false, reason: "already_published" }
        : await emitDisclosureEvent(published.hash, auth.wallet);
      const access = resolveContentAccess(published, auth);
      respond(response, 200, {
        ...contentResponse(published, access),
        disclosureEvent,
        contentURI: publicContentUri(published.hash)
      }, publicContentHeaders(published, access));
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/content/")) {
      const hash = normalizeContentHash(decodeURIComponent(pathname.slice("/content/".length)));
      const record = await stateStore.getContent?.(hash);
      if (!record) {
        respond(response, 404, { status: "not_found", hash });
        return true;
      }
      const auth = await optionalAuth(request, url);
      const access = requireContentAccess(record, auth);
      const autoDisclosureEvent = access.public
        ? await maybeEmitAutoDisclosureEvent(record)
        : { emitted: false, reason: "private" };
      respond(response, 200, {
        ...contentResponse(record, access),
        autoDisclosureEvent
      }, publicContentHeaders(record, access));
      return true;
    }

    return false;
  };
}
