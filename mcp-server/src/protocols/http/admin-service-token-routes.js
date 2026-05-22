import { listAllKnownCapabilities } from "../../auth/capabilities.js";
import { buildCapabilityGrant, GRANT_STATUS, projectGrant } from "../../core/capability-grants.js";
import { ConflictError, ValidationError } from "../../core/errors.js";

function serviceTokenGrantIdFromPath(pathname, suffix) {
  const grantId = decodeURIComponent(pathname.slice("/admin/service-tokens/".length, -suffix.length));
  if (!grantId) {
    throw new ValidationError("grantId is required.");
  }
  return grantId;
}

export function createAdminServiceTokenRoutes({
  assertIssuerCanGrantCapabilities,
  authMiddleware,
  buildMutationRequestHash,
  enforceLimit,
  eventBus,
  getIdempotentMutationReplay,
  parseIdempotencyKey,
  parseLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  revokeCapabilityGrantRecord,
  serviceTokenIssueResponse,
  serviceTokenReplayResponse,
  signServiceToken,
  stateStore,
  storeIdempotentMutationReceipt,
}) {
  return async function handleAdminServiceTokenRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/service-tokens") {
      await authMiddleware(request, url, { requireRole: "admin" });
      const subject = (url.searchParams.get("subject") ?? "").trim().toLowerCase() || undefined;
      const status = (url.searchParams.get("status") ?? "").trim().toLowerCase() || undefined;
      const limit = parseLimit(url, 50, 200);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const grants = (await stateStore.listCapabilityGrants?.({ subject, status, limit, offset })) ?? [];
      respond(response, 200, {
        items: grants.map((grant) => ({
          tokenKind: "service",
          tokenAvailable: false,
          grant: projectGrant(grant)
        })).filter((entry) => entry.grant),
        limit,
        offset
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/service-tokens") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/service-tokens",
        wallet: auth.wallet,
        payload
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "service_token_issue",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const grant = buildCapabilityGrant(payload ?? {}, {
        knownCapabilities: listAllKnownCapabilities(),
        issuerWallet: auth.wallet
      });
      assertIssuerCanGrantCapabilities(grant, auth);
      await stateStore.upsertCapabilityGrant?.(grant);
      authMiddleware.invalidateCapabilityGrantCache?.(grant.subject);
      const { token, claims } = await signServiceToken(grant, payload);
      const body = serviceTokenIssueResponse({ grant, token, claims });
      await storeIdempotentMutationReceipt({
        bucket: "service_token_issue",
        key: mutationKey,
        requestHash,
        response: serviceTokenReplayResponse(body),
        statusCode: 201
      });
      eventBus?.publish({
        id: `service-token-issue-${grant.id}-${Date.now()}`,
        topic: "service-token.issue",
        wallet: auth.wallet,
        wallets: [auth.wallet, grant.subject],
        timestamp: new Date().toISOString(),
        data: {
          grantId: grant.id,
          subject: grant.subject,
          capabilities: grant.capabilities,
          scope: grant.scope ?? null,
          tokenExpiresAt: body.expiresAt
        }
      });
      respond(response, 201, body);
      return true;
    }

    if (request.method === "POST" && pathname.startsWith("/admin/service-tokens/") && pathname.endsWith("/rotate")) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const grantId = serviceTokenGrantIdFromPath(pathname, "/rotate");
      const payload = await readJsonBody(request);
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${grantId}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/service-tokens/:id/rotate",
        wallet: auth.wallet,
        payload: { grantId, ...payload }
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "service_token_rotate",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const current = await stateStore.getCapabilityGrant?.(grantId);
      if (!current) {
        throw new ValidationError("Unknown grant id.", { grantId });
      }
      if (current.status !== GRANT_STATUS.active) {
        throw new ConflictError("Cannot rotate a revoked service token grant.", "service_token_grant_revoked", {
          grantId
        });
      }
      const nextGrant = buildCapabilityGrant({
        subject: current.subject,
        capabilities: payload?.capabilities ?? current.capabilities,
        scope: payload?.scope ?? current.scope,
        note: payload?.note ?? current.note,
        expiresAt: payload?.expiresAt ?? current.expiresAt,
        issuedAt: payload?.issuedAt,
        nonce: payload?.nonce
      }, {
        knownCapabilities: listAllKnownCapabilities(),
        issuerWallet: auth.wallet
      });
      assertIssuerCanGrantCapabilities(nextGrant, auth);
      const { record: revoked } = await revokeCapabilityGrantRecord({
        grantId,
        auth,
        note: payload?.revokeNote ?? "rotated service token"
      });
      await stateStore.upsertCapabilityGrant?.(nextGrant);
      authMiddleware.invalidateCapabilityGrantCache?.(nextGrant.subject);
      const { token, claims } = await signServiceToken(nextGrant, payload);
      const body = serviceTokenIssueResponse({ grant: nextGrant, token, claims, rotatedFrom: revoked });
      await storeIdempotentMutationReceipt({
        bucket: "service_token_rotate",
        key: mutationKey,
        requestHash,
        response: serviceTokenReplayResponse(body),
        statusCode: 201
      });
      eventBus?.publish({
        id: `service-token-rotate-${nextGrant.id}-${Date.now()}`,
        topic: "service-token.rotate",
        wallet: auth.wallet,
        wallets: [auth.wallet, nextGrant.subject],
        timestamp: new Date().toISOString(),
        data: {
          previousGrantId: grantId,
          grantId: nextGrant.id,
          subject: nextGrant.subject,
          capabilities: nextGrant.capabilities,
          scope: nextGrant.scope ?? null,
          tokenExpiresAt: body.expiresAt
        }
      });
      respond(response, 201, body);
      return true;
    }

    if (request.method === "POST" && pathname.startsWith("/admin/service-tokens/") && pathname.endsWith("/revoke")) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const grantId = serviceTokenGrantIdFromPath(pathname, "/revoke");
      const payload = (await readJsonBody(request).catch(() => undefined)) ?? {};
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${grantId}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/service-tokens/:id/revoke",
        wallet: auth.wallet,
        payload: { grantId, ...payload }
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "service_token_revoke",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const { record, alreadyRevoked } = await revokeCapabilityGrantRecord({
        grantId,
        auth,
        note: payload?.note
      });
      const body = {
        tokenKind: "service",
        tokenAvailable: false,
        status: "revoked",
        alreadyRevoked,
        grant: projectGrant(record)
      };
      await storeIdempotentMutationReceipt({
        bucket: "service_token_revoke",
        key: mutationKey,
        requestHash,
        response: body,
        statusCode: 200
      });
      if (!alreadyRevoked) {
        eventBus?.publish({
          id: `service-token-revoke-${record.id}-${Date.now()}`,
          topic: "service-token.revoke",
          wallet: auth.wallet,
          wallets: [auth.wallet, record.subject],
          timestamp: new Date().toISOString(),
          data: {
            grantId: record.id,
            subject: record.subject,
            revokedBy: record.revokedBy ?? auth.wallet
          }
        });
      }
      respond(response, 200, body);
      return true;
    }

    return false;
  };
}
