import { signTokenFromConfig } from "../../auth/jwt.js";
import { listAllKnownCapabilities } from "../../auth/capabilities.js";
import {
  applyRevocation,
  buildCapabilityGrant,
  GRANT_STATUS,
  projectGrant
} from "../../core/capability-grants.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ValidationError
} from "../../core/errors.js";

const SERVICE_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

function assertIssuerCanGrantCapabilities(grant, auth) {
  const issuerCapabilities = new Set(Array.isArray(auth?.capabilities) ? auth.capabilities : []);
  const missingCapabilities = (Array.isArray(grant?.capabilities) ? grant.capabilities : [])
    .filter((capability) => !issuerCapabilities.has(capability))
    .sort();

  if (missingCapabilities.length) {
    throw new AuthorizationError(
      "Cannot grant capabilities the issuer token does not have.",
      "grant_capability_not_owned",
      {
        grantId: grant?.id,
        issuerWallet: auth?.wallet,
        missingCapabilities
      }
    );
  }
}

function normalizeServiceTokenTtlSeconds(payload, grant, authConfig) {
  const requested = payload?.tokenTtlSeconds === undefined || payload?.tokenTtlSeconds === null
    ? authConfig.tokenTtlSeconds
    : Number(payload.tokenTtlSeconds);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new ValidationError("tokenTtlSeconds must be a positive integer.");
  }
  let ttlSeconds = Math.min(requested, SERVICE_TOKEN_MAX_TTL_SECONDS);
  if (grant?.expiresAt) {
    const remaining = Math.floor((Date.parse(grant.expiresAt) - Date.now()) / 1000);
    if (remaining <= 0) {
      throw new ValidationError("Cannot issue a service token for an expired grant.", {
        grantId: grant.id,
        expiresAt: grant.expiresAt
      });
    }
    ttlSeconds = Math.min(ttlSeconds, remaining);
  }
  return Math.max(1, ttlSeconds);
}

async function signServiceToken({ grant, payload = {}, authConfig, signTokenFromConfigImpl }) {
  if (!authConfig.signingSecret && authConfig.jwtBackend === "hmac") {
    // Under JWT_BACKEND=hmac the dispatcher still needs an HMAC secret.
    // Under kms / both the secret may legitimately be absent (we're past
    // the HMAC retirement window).
    throw new AuthenticationError(
      "Auth not configured — set AUTH_JWT_SECRETS to issue service tokens.",
      "auth_not_configured"
    );
  }
  const ttlSeconds = normalizeServiceTokenTtlSeconds(payload, grant, authConfig);
  // Phase 4b.6 Stage 2C-1 — route through the dispatcher so service-token
  // mint respects JWT_PRIMARY_ALG (HS256 today, ES256 once 2C-2 flips
  // JWT_BACKEND=kms). The `roles: ["service"]` claim is informational —
  // capabilities for a service token come from the capabilityGrantId
  // lookup in middleware.expandCapabilities, not from hasRole. The
  // "service" entry is in VALID_ROLES (auth/config.js) so KmsJwtSigner's
  // expectedRoles allowlist accepts the ES256 shape after 2C-2.
  return await signTokenFromConfigImpl(
    {
      sub: grant.subject,
      roles: ["service"],
      tokenKind: "service",
      serviceToken: true,
      capabilityGrantId: grant.id,
      ...(grant.scope ? { serviceScope: grant.scope } : {})
    },
    { expiresInSeconds: ttlSeconds },
    authConfig,
  );
}

function serviceTokenIssueResponse({ grant, token, claims, rotatedFrom = undefined }) {
  return {
    token,
    tokenType: "Bearer",
    tokenKind: "service",
    tokenAvailable: true,
    wallet: grant.subject,
    capabilities: [...grant.capabilities],
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    grant: projectGrant(grant),
    ...(rotatedFrom ? { rotatedFrom: projectGrant(rotatedFrom) } : {}),
    usage: {
      header: "Authorization: Bearer <token>"
    }
  };
}

function serviceTokenReplayResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const { token, ...rest } = payload;
  void token;
  return {
    ...rest,
    tokenAvailable: false,
    tokenOmittedReason: "service_token_secret_is_returned_once"
  };
}

export function createAdminCapabilityRoutes({
  authConfig,
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
  signTokenFromConfigImpl = signTokenFromConfig,
  stateStore,
  storeIdempotentMutationReceipt,
}) {
  async function authenticateAndLimit(request, url) {
    const auth = await authMiddleware(request, url, { requireRole: "admin" });
    await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
    return auth;
  }

  async function revokeCapabilityGrantRecord({ grantId, auth, note }) {
    const current = await stateStore.getCapabilityGrant?.(grantId);
    if (!current) {
      throw new ValidationError("Unknown grant id.", { grantId });
    }
    const { record, alreadyRevoked } = applyRevocation(current, {
      revokedBy: auth.wallet,
      revokeNote: note
    });
    if (!alreadyRevoked) {
      await stateStore.upsertCapabilityGrant?.(record);
      authMiddleware.invalidateCapabilityGrantCache?.(record.subject);
    }
    return { current, record, alreadyRevoked };
  }

  return async function handleAdminCapabilityRoute({ request, response, url, pathname }) {
    /*
     * Capability grants — operator-issued, scoped delegations of
     * platform capabilities to a subject wallet (a service token,
     * an automation bot, or a co-operator). Modelled after
     * Polkadot's Staking Operator Proxy: a strict subset of the
     * issuer's capabilities, no further delegation, revocable at
     * any time. Roadmap §6.
     */
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
      const auth = await authenticateAndLimit(request, url);
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
      const { token, claims } = await signServiceToken({ grant, payload, authConfig, signTokenFromConfigImpl });
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
      const auth = await authenticateAndLimit(request, url);
      const grantId = decodeURIComponent(pathname.slice("/admin/service-tokens/".length, -"/rotate".length));
      if (!grantId) {
        throw new ValidationError("grantId is required.");
      }
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
      const { token, claims } = await signServiceToken({ grant: nextGrant, payload, authConfig, signTokenFromConfigImpl });
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
      const auth = await authenticateAndLimit(request, url);
      const grantId = decodeURIComponent(pathname.slice("/admin/service-tokens/".length, -"/revoke".length));
      if (!grantId) {
        throw new ValidationError("grantId is required.");
      }
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
