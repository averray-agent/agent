import { AppError, AuthenticationError, AuthorizationError, ConflictError } from "../../core/errors.js";
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
} from "../../core/content-addressed-store.js";

const CONTENT_QUOTA_BYTES = 1024 * 1024;
const CONTENT_QUOTA_WINDOW_SECONDS = 24 * 60 * 60;

export function createContentRoutes({
  appendContentRecord,
  authMiddleware,
  enforceLimit,
  escrowAddress = "",
  hasRole,
  metrics,
  persistContentRecord,
  publicBaseUrl,
  rateLimitConfig,
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

  function countWrite(outcome) {
    metrics?.counter("content_writes_total", "Content write outcomes", ["outcome"]).inc({ outcome });
  }

  function respondExisting(response, existing, auth) {
    countWrite("exists");
    if (!walletsMatch(existing.ownerWallet, auth.wallet)) {
      throw new ConflictError("Content already exists.", "content_exists");
    }
    respond(response, 200, {
      ...contentResponse(existing, resolveContentAccess(existing, auth)),
      contentURI: publicContentUri(existing.hash)
    });
  }

  return async function handleContentRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/content") {
      const auth = await authMiddleware(request, url);
      try {
        await enforceLimit("content_writes", auth.wallet, rateLimitConfig.contentWrites);
      } catch (error) {
        if (error?.code === "rate_limited") countWrite("rate_limited");
        throw error;
      }
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
      const existing = await stateStore.getContent(record.hash);
      if (existing) {
        respondExisting(response, existing, auth);
        return true;
      }
      if (!hasRole(auth.claims, "admin")) {
        const quota = await stateStore.consumeWalletQuota(
          "content_bytes", auth.wallet, Buffer.byteLength(JSON.stringify(record)), CONTENT_QUOTA_WINDOW_SECONDS
        );
        if (quota.usedBytes > CONTENT_QUOTA_BYTES) {
          countWrite("quota_exceeded");
          throw new AppError("Content byte quota exceeded. Retry after the window resets.", {
            code: "content_quota_exceeded",
            statusCode: 429,
            details: {
              limitBytes: CONTENT_QUOTA_BYTES,
              resetAt: new Date(quota.resetAt).toISOString(),
              retryAfterSeconds: Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000))
            }
          });
        }
      }
      const result = await stateStore.createContentIfAbsent(record);
      if (!result.created) {
        respondExisting(response, result.record, auth);
        return true;
      }
      await appendContentRecord?.(record);
      countWrite("created");
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
      const published = publishContentRecord(record);
      await persistContentRecord(published);
      const disclosureEvent = {
        emitted: false, reason: "self_disclosure", contract: escrowAddress, method: "disclose(bytes32)"
      };
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
      const autoDisclosureEvent = { emitted: false, reason: "reads_never_write" };
      respond(response, 200, {
        ...contentResponse(record, access),
        autoDisclosureEvent
      }, publicContentHeaders(record, access));
      return true;
    }

    return false;
  };
}
