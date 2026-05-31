import { AuthorizationError } from "../../core/errors.js";
import {
  issueShareToken,
  normalizeShareId,
  normalizeShareSurface,
  normalizeShareTtlSeconds,
  resolveShareSecret,
  verifyShareToken
} from "../../core/share-links.js";

export function createShareRoutes({
  authConfig,
  authMiddleware,
  authorizeShareTarget,
  publicBaseUrl,
  readJsonBody,
  resolveShareResource,
  respond,
}) {
  const secret = () => resolveShareSecret({ authConfig });

  return async function handleShareRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/shares") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const surface = normalizeShareSurface(payload?.surface);
      const id = normalizeShareId(payload?.id ?? payload?.wallet ?? payload?.sessionId ?? payload?.disputeId ?? payload?.tag);
      const ttlSeconds = normalizeShareTtlSeconds(payload?.ttlSeconds);

      await authorizeShareTarget({ surface, id, auth });

      const issued = issueShareToken({
        surface,
        id,
        ttlSeconds,
        secret: secret()
      });
      const appPath = `/share?token=${encodeURIComponent(issued.token)}`;
      const apiPath = `/shares/${issued.token}`;
      respond(response, 201, {
        status: "created",
        share: {
          surface,
          id,
          mode: "read_only",
          issuedAt: issued.payload.issuedAt,
          expiresAt: issued.payload.expiresAt,
          ttlSeconds
        },
        token: issued.token,
        appPath,
        apiPath,
        ...(publicBaseUrl ? { apiUrl: `${publicBaseUrl.replace(/\/+$/u, "")}${apiPath}` } : {})
      });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/shares/")) {
      const token = pathname.slice("/shares/".length);
      const share = verifyShareToken(token, { secret: secret() });
      const resource = await resolveShareResource(share);
      if (!resource) {
        throw new AuthorizationError("Shared resource is no longer available.", "share_resource_unavailable");
      }
      respond(response, 200, {
        status: "ok",
        share: {
          surface: share.surface,
          id: share.id,
          mode: "read_only",
          issuedAt: share.issuedAt,
          expiresAt: share.expiresAt
        },
        resource
      }, {
        "cache-control": "private, no-store"
      });
      return true;
    }

    return false;
  };
}
