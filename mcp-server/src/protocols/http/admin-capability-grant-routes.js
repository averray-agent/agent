import { listAllKnownCapabilities } from "../../auth/capabilities.js";
import {
  applyRevocation,
  buildCapabilityGrant,
  projectGrant
} from "../../core/capability-grants.js";
import { ValidationError } from "../../core/errors.js";

export function createAdminCapabilityGrantRoutes({
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
  stateStore,
  storeIdempotentMutationReceipt,
}) {
  async function authenticateAndLimit(request, url) {
    const auth = await authMiddleware(request, url, { requireRole: "admin" });
    await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
    return auth;
  }

  return async function handleAdminCapabilityGrantRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/capability-grants") {
      await authMiddleware(request, url, { requireRole: "admin" });
      const subject = (url.searchParams.get("subject") ?? "").trim().toLowerCase() || undefined;
      const status = (url.searchParams.get("status") ?? "").trim().toLowerCase() || undefined;
      const limit = parseLimit(url, 50, 200);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const grants = (await stateStore.listCapabilityGrants?.({ subject, status, limit, offset })) ?? [];
      respond(response, 200, {
        items: grants.map((grant) => projectGrant(grant)).filter(Boolean),
        limit,
        offset
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/capability-grants") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/capability-grants",
        wallet: auth.wallet,
        payload
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "capability_grant",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const knownCapabilities = listAllKnownCapabilities();
      const grant = buildCapabilityGrant(payload ?? {}, {
        knownCapabilities,
        issuerWallet: auth.wallet
      });
      assertIssuerCanGrantCapabilities(grant, auth);
      await stateStore.upsertCapabilityGrant?.(grant);
      authMiddleware.invalidateCapabilityGrantCache?.(grant.subject);
      const projection = projectGrant(grant);
      await storeIdempotentMutationReceipt({
        bucket: "capability_grant",
        key: mutationKey,
        requestHash,
        response: projection,
        statusCode: 201
      });
      eventBus?.publish({
        id: `capability-grant-${grant.id}-${Date.now()}`,
        topic: "capability.grant",
        wallet: auth.wallet,
        wallets: [auth.wallet, grant.subject],
        timestamp: new Date().toISOString(),
        data: {
          grantId: grant.id,
          subject: grant.subject,
          capabilities: grant.capabilities,
          scope: grant.scope ?? null
        }
      });
      respond(response, 201, projection);
      return true;
    }

    if (request.method === "POST" && pathname.startsWith("/admin/capability-grants/") && pathname.endsWith("/revoke")) {
      const auth = await authenticateAndLimit(request, url);
      const grantId = decodeURIComponent(pathname.slice("/admin/capability-grants/".length, -"/revoke".length));
      if (!grantId) {
        throw new ValidationError("grantId is required.");
      }
      const payload = (await readJsonBody(request).catch(() => undefined)) ?? {};
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${grantId}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/capability-grants/:id/revoke",
        wallet: auth.wallet,
        payload: { grantId, ...payload }
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "capability_revoke",
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
      const { record, alreadyRevoked } = applyRevocation(current, {
        revokedBy: auth.wallet,
        revokeNote: payload?.note
      });
      if (!alreadyRevoked) {
        await stateStore.upsertCapabilityGrant?.(record);
        authMiddleware.invalidateCapabilityGrantCache?.(record.subject);
      }
      const projection = projectGrant(record);
      await storeIdempotentMutationReceipt({
        bucket: "capability_revoke",
        key: mutationKey,
        requestHash,
        response: projection,
        statusCode: 200
      });
      if (!alreadyRevoked) {
        eventBus?.publish({
          id: `capability-revoke-${record.id}-${Date.now()}`,
          topic: "capability.revoke",
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
      respond(response, 200, projection);
      return true;
    }

    return false;
  };
}
