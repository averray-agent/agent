import { randomBytes } from "node:crypto";

import { AuthenticationError, ValidationError } from "../../core/errors.js";
import { parseWalletIdentity } from "../../core/wallet-identity.js";
import { buildSiweMessage, verifySiweMessage } from "../../auth/siwe.js";
import { signTokenFromConfig } from "../../auth/jwt.js";
import {
  REFRESH_COOKIE_NAME,
  RefreshError,
  consumeRefreshToken,
  hashRefreshToken,
  issueRefreshToken,
  revokeChain,
  rotateRefreshToken,
} from "../../auth/refresh.js";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  makeRefreshStoreAdapter,
  parseCookie,
} from "../../auth/refresh-cookie.js";

const SIWE_STATEMENT = "Sign in to the Agent Platform.";
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/u;
// Keep the existing EVM request boundary byte-for-byte. Native signatures are
// 64 bytes, but that alternate shape is admitted only when the identity line
// in the signed message is itself a valid SS58 AccountId32.
const EVM_SIGNATURE_RE = /^(0x)?[0-9a-fA-F]{130,132}$/u;
const SUBSTRATE_SIGNATURE_RE = /^(?:0x)?(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/u;

function generateNonce(randomBytesImpl) {
  return randomBytesImpl(16).toString("hex");
}

function walletsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function signaturePatternForMessage(message) {
  const address = String(message ?? "").split("\n", 2)[1]?.trim();
  try {
    return parseWalletIdentity(address).source === "ss58"
      ? SUBSTRATE_SIGNATURE_RE
      : EVM_SIGNATURE_RE;
  } catch {
    return EVM_SIGNATURE_RE;
  }
}

// True when the configured primary JWT signer can actually mint a token.
// Under JWT_BACKEND=kms there is no HMAC `signingSecret` (the KMS-only mainnet
// posture renders none — MAIN-001), yet signTokenFromConfig can still issue
// ES256 via the KMS JWT signer. Gating on `signingSecret` alone wrongly locked
// out SIWE verify/refresh in that posture, so check the primary signer instead.
function canIssueTokens(authConfig) {
  return authConfig?.jwtPrimaryAlg === "kms"
    ? Boolean(authConfig?.kmsJwt)
    : Boolean(authConfig?.signingSecret);
}

function supportsRefreshStore(stateStore) {
  return Boolean(
    stateStore
    && typeof stateStore.getRefreshRecord === "function"
    && typeof stateStore.upsertRefreshRecord === "function"
  );
}

function buildTokenResponse({ token, claims, wallet, roles, authCapabilities, extra = {} }) {
  return {
    token,
    wallet,
    roles,
    capabilities: authCapabilities.resolveCapabilities(claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    tokenType: "Bearer",
    ...extra,
  };
}

export function createAuthRoutes({
  authCapabilities,
  authConfig,
  authMiddleware,
  buildClearCookieHeaderImpl = buildClearCookieHeader,
  buildSetCookieHeaderImpl = buildSetCookieHeader,
  buildSiweMessageImpl = buildSiweMessage,
  clientIp,
  consumeRefreshTokenImpl = consumeRefreshToken,
  enforceLimit,
  eventBus,
  hashRefreshTokenImpl = hashRefreshToken,
  issueRefreshTokenImpl = issueRefreshToken,
  logger,
  makeRefreshStoreAdapterImpl = makeRefreshStoreAdapter,
  parseCookieImpl = parseCookie,
  randomBytesImpl = randomBytes,
  rateLimitConfig,
  readJsonBody,
  respond,
  revokeChainImpl = revokeChain,
  rotateRefreshTokenImpl = rotateRefreshToken,
  signTokenFromConfigImpl = signTokenFromConfig,
  stateStore,
  verifySiweMessageImpl = verifySiweMessage,
}) {
  function respondHandled(response, statusCode, body, headers = {}) {
    respond(response, statusCode, body, headers);
    return true;
  }

  async function recordSiweAuthEvent(event) {
    try {
      await stateStore.recordSiweAuthEvent?.(event);
    } catch (error) {
      // Telemetry must not make an otherwise-valid auth exchange fail. The
      // state-store warning is still an explicit trace that observability
      // degraded for this wallet/event.
      logger?.warn?.(
        { err: error, wallet: event.wallet, event: event.event },
        "auth_siwe.telemetry_write_failed"
      );
    }
  }

  return async function handleAuthRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/auth/nonce") {
      await enforceLimit("auth_nonce", clientIp(request), rateLimitConfig.authNonce);
      const payload = await readJsonBody(request);
      const wallet = String(payload?.wallet ?? "").trim();
      let walletIdentity;
      try {
        // WALLET_RE remains the unchanged H160 validator. Identity routing is
        // shared: the alternate accepted form is parsed as a real SS58
        // AccountId32 rather than loosening the EVM regex.
        const hasH160Shape = WALLET_RE.test(wallet);
        walletIdentity = parseWalletIdentity(wallet);
        if ((walletIdentity.source === "h160") !== hasH160Shape) throw new Error("identity_shape");
      } catch {
        throw new ValidationError("wallet must be a 0x-prefixed 20-byte hex address.");
      }
      request._arrivalWallet = walletIdentity.h160;
      const nonce = generateNonce(randomBytesImpl);
      const stored = await stateStore.storeNonce?.(
        nonce,
        walletIdentity.h160,
        authConfig.nonceTtlSeconds
      );
      if (stored === false) {
        throw new ValidationError("Nonce collision — retry.");
      }
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + authConfig.nonceTtlSeconds * 1000).toISOString();
      await recordSiweAuthEvent({
        wallet: walletIdentity.h160,
        event: "nonce_issued",
        at: issuedAt
      });
      return respondHandled(response, 200, {
        wallet,
        nonce,
        domain: authConfig.domain,
        chainId: authConfig.chainId,
        statement: SIWE_STATEMENT,
        issuedAt,
        expiresAt,
        message: buildSiweMessageImpl({
          domain: authConfig.domain,
          address: wallet,
          statement: SIWE_STATEMENT,
          uri: `https://${authConfig.domain}`,
          chainId: authConfig.chainId,
          nonce,
          issuedAt,
          expirationTime: expiresAt
        })
      });
    }

    if (request.method === "POST" && pathname === "/auth/verify") {
      await enforceLimit("auth_verify", clientIp(request), rateLimitConfig.authVerify);
      const payload = await readJsonBody(request);
      const message = typeof payload?.message === "string" ? payload.message : "";
      const signature = typeof payload?.signature === "string" ? payload.signature : "";
      if (!message || !signature) {
        throw new ValidationError("message and signature are required.");
      }
      if (message.length > 4096) {
        throw new ValidationError("SIWE message exceeds 4096 characters.");
      }
      if (!signaturePatternForMessage(message).test(signature)) {
        throw new ValidationError("signature must be a 65-byte hex string.");
      }
      if (!canIssueTokens(authConfig)) {
        throw new AuthenticationError(
          "Auth not configured — configure the JWT signer (AUTH_JWT_SECRETS for HMAC, or the KMS JWT signer for ES256).",
          "auth_not_configured"
        );
      }

      const verified = verifySiweMessageImpl(message, signature, {
        expectedDomain: authConfig.domain,
        expectedChainId: authConfig.chainId
      });
      const walletIdentity = verified.walletIdentity
        ?? parseWalletIdentity(verified.recoveredAddress);

      const consumedWallet = await stateStore.consumeNonce?.(verified.nonce);
      if (!consumedWallet) {
        throw new AuthenticationError("Nonce missing or already consumed.", "invalid_nonce");
      }
      if (!walletsMatch(consumedWallet, walletIdentity.h160)) {
        throw new AuthenticationError("Nonce was issued for a different wallet.", "nonce_wallet_mismatch");
      }

      // ethers' signature recovery returns an EIP-55 checksummed address. EVM
      // subjects retain the platform's lowercase H160 contract; native
      // subjects retain their exact, case-sensitive SS58 form and carry the
      // derived lowercase H160 separately for service/store indexing.
      const wallet = walletIdentity.h160;
      const subject = walletIdentity.source === "ss58" ? walletIdentity.ss58 : wallet;
      request._arrivalWallet = wallet;

      const roles = walletIdentity.source === "ss58"
        ? []
        : authConfig.resolveRoles?.(wallet) ?? [];
      const tokenPayload = {
        sub: subject,
        roles,
        ...(walletIdentity.source === "ss58" ? { walletIdentity } : {})
      };
      const { token, claims } = await signTokenFromConfigImpl(
        tokenPayload,
        { expiresInSeconds: authConfig.tokenTtlSeconds },
        authConfig,
      );

      let setCookieHeader = null;
      try {
        if (walletIdentity.source === "h160" && supportsRefreshStore(stateStore)) {
          const refreshAdapter = makeRefreshStoreAdapterImpl(stateStore);
          const refreshIssue = await issueRefreshTokenImpl({
            wallet,
            role: roles[0] ?? "user",
            store: refreshAdapter,
          });
          setCookieHeader = buildSetCookieHeaderImpl(refreshIssue.rawToken);
        }
      } catch (err) {
        logger?.warn?.(
          { err, wallet },
          "auth_verify.refresh_issue_failed"
        );
      }

      const verifiedAt = new Date().toISOString();
      await recordSiweAuthEvent({
        wallet,
        event: "verify_succeeded",
        at: verifiedAt
      });
      // Identity begins only after the signature verifies. At that point the
      // signed message lets us attach both timestamps to the recovered wallet
      // without retaining its nonce, signature, or message.
      publishJourneyAuthEvent(eventBus, {
        wallet,
        topic: "journey.auth_nonce_issued",
        timestamp: verified.issuedAt,
        outcome: "issued"
      });
      publishJourneyAuthEvent(eventBus, {
        wallet,
        topic: "journey.auth_verified",
        timestamp: verifiedAt,
        outcome: "succeeded"
      });

      return respondHandled(
        response,
        200,
        buildTokenResponse({
          token,
          claims,
          wallet: subject,
          roles,
          authCapabilities,
          extra: walletIdentity.source === "ss58" ? { walletIdentity } : {},
        }),
        setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}
      );
    }

    if (request.method === "GET" && pathname === "/auth/session") {
      const auth = await authMiddleware(request, url);
      const nativeIdentity = auth.claims?.walletIdentity?.source === "ss58"
        ? auth.claims.walletIdentity
        : undefined;
      return respondHandled(response, 200, {
        wallet: nativeIdentity ? auth.claims.sub : auth.wallet,
        ...(nativeIdentity ? { walletIdentity: nativeIdentity } : {}),
        roles: auth.claims?.roles ?? [],
        tokenKind: auth.claims?.tokenKind ?? (auth.claims?.serviceToken === true ? "service" : "wallet"),
        serviceToken: auth.claims?.serviceToken === true,
        ...(auth.claims?.capabilityGrantId ? { capabilityGrantId: auth.claims.capabilityGrantId } : {}),
        capabilities: auth.capabilities ?? [],
        capabilityMatrix: authCapabilities.capabilityMatrix()
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      const auth = await authMiddleware(request, url);
      const jti = auth.claims?.jti;
      const exp = auth.claims?.exp;
      if (jti && Number.isFinite(exp)) {
        const ttlSeconds = Math.max(1, exp - Math.floor(Date.now() / 1000));
        await stateStore.revokeToken?.(jti, ttlSeconds);
      }

      const refreshCookie = parseCookieImpl(request.headers?.cookie ?? null, REFRESH_COOKIE_NAME);
      if (refreshCookie && supportsRefreshStore(stateStore)) {
        try {
          const refreshAdapter = makeRefreshStoreAdapterImpl(stateStore);
          const hash = hashRefreshTokenImpl(refreshCookie);
          await revokeChainImpl({
            hash,
            store: refreshAdapter,
            reason: "logout",
          });
        } catch (err) {
          logger?.warn?.({ err, wallet: auth.wallet }, "auth_logout.refresh_chain_revoke_failed");
        }
      }

      return respondHandled(
        response,
        200,
        {
          status: "logged_out",
          wallet: auth.claims?.walletIdentity?.source === "ss58"
            ? auth.claims.sub
            : auth.wallet,
          jti
        },
        { "Set-Cookie": buildClearCookieHeaderImpl() }
      );
    }

    if (request.method === "POST" && pathname === "/auth/refresh") {
      const refreshCookie = parseCookieImpl(request.headers?.cookie ?? null, REFRESH_COOKIE_NAME);

      if (refreshCookie && supportsRefreshStore(stateStore)) {
        await enforceLimit("auth_refresh", clientIp(request), rateLimitConfig.authRefresh);
        if (!canIssueTokens(authConfig)) {
          throw new AuthenticationError(
            "Auth not configured — configure the JWT signer (AUTH_JWT_SECRETS for HMAC, or the KMS JWT signer for ES256).",
            "auth_not_configured"
          );
        }

        const refreshAdapter = makeRefreshStoreAdapterImpl(stateStore);

        let consumed;
        try {
          consumed = await consumeRefreshTokenImpl({ rawToken: refreshCookie, store: refreshAdapter });
        } catch (err) {
          response.setHeader?.("Set-Cookie", buildClearCookieHeaderImpl());
          if (err instanceof RefreshError) {
            const code = err.code === "refresh_replay_detected"
              ? "refresh_replay_detected"
              : err.code === "refresh_expired"
                ? "refresh_expired"
                : err.code === "refresh_revoked"
                  ? "refresh_revoked"
                  : "invalid_refresh_token";
            logger?.warn?.(
              { code, hashPrefix: err.details?.hashPrefix },
              "auth_refresh.cookie_rejected"
            );
            throw new AuthenticationError(err.message, code);
          }
          throw err;
        }

        const roles = authConfig.resolveRoles?.(consumed.record.wallet) ?? [];
        request._arrivalWallet = consumed.record.wallet.toLowerCase();
        if (roles.length === 0) {
          await revokeChainImpl({
            hash: consumed.hash,
            store: refreshAdapter,
            reason: "no_roles_at_refresh",
          });
          response.setHeader?.("Set-Cookie", buildClearCookieHeaderImpl());
          logger?.warn?.(
            { wallet: consumed.record.wallet },
            "auth_refresh.no_roles_chain_revoked"
          );
          throw new AuthenticationError(
            "Wallet has no roles at refresh time.",
            "no_roles_at_refresh"
          );
        }

        const primaryRole = roles[0];
        const rotated = await rotateRefreshTokenImpl({
          oldRecord: { ...consumed.record, role: primaryRole },
          oldHash: consumed.hash,
          store: refreshAdapter,
        });

        // Defensive lowercase: new refresh records seed a lowercase wallet
        // (see /auth/verify), but records issued before that fix landed hold a
        // checksummed wallet. Every minted `sub` must be lowercase or the
        // verifier rejects it (claims_mismatch).
        const { token, claims } = await signTokenFromConfigImpl(
          { sub: consumed.record.wallet.toLowerCase(), roles },
          { expiresInSeconds: authConfig.tokenTtlSeconds },
          authConfig,
        );

        return respondHandled(
          response,
          200,
          buildTokenResponse({
            token,
            claims,
            wallet: consumed.record.wallet,
            roles,
            authCapabilities,
          }),
          { "Set-Cookie": buildSetCookieHeaderImpl(rotated.rawToken) }
        );
      }

      const auth = await authMiddleware(request, url);
      if (auth.claims?.serviceToken === true || auth.claims?.tokenKind === "service") {
        throw new AuthenticationError(
          "Service tokens cannot be refreshed via /auth/refresh; rotate them via /admin/service-tokens/:id/rotate.",
          "service_token_refresh_unsupported"
        );
      }
      await enforceLimit("auth_refresh", auth.wallet, rateLimitConfig.authRefresh);
      if (!canIssueTokens(authConfig)) {
        throw new AuthenticationError(
          "Auth not configured — configure the JWT signer (AUTH_JWT_SECRETS for HMAC, or the KMS JWT signer for ES256).",
          "auth_not_configured"
        );
      }

      const oldJti = auth.claims?.jti;
      const oldExp = auth.claims?.exp;
      if (oldJti && Number.isFinite(oldExp)) {
        const ttlSeconds = Math.max(1, oldExp - Math.floor(Date.now() / 1000));
        await stateStore.revokeToken?.(oldJti, ttlSeconds);
      }

      const nativeIdentity = auth.claims?.walletIdentity?.source === "ss58"
        ? auth.claims.walletIdentity
        : undefined;
      const effectiveRoles = nativeIdentity
        ? []
        : authConfig.resolveRoles?.(auth.wallet) ?? auth.claims?.roles ?? [];
      // EVM auth.wallet derives from a verified lowercase token subject;
      // Substrate sessions preserve their case-sensitive SS58 subject.
      const subject = nativeIdentity ? auth.claims.sub : auth.wallet.toLowerCase();
      const { token, claims } = await signTokenFromConfigImpl(
        {
          sub: subject,
          roles: effectiveRoles,
          ...(nativeIdentity ? { walletIdentity: nativeIdentity } : {})
        },
        { expiresInSeconds: authConfig.tokenTtlSeconds },
        authConfig,
      );

      return respondHandled(response, 200, buildTokenResponse({
        token,
        claims,
        wallet: subject,
        roles: effectiveRoles,
        authCapabilities,
        extra: {
          rotatedFromJti: oldJti,
          ...(nativeIdentity ? { walletIdentity: nativeIdentity } : {})
        }
      }));
    }

    return false;
  };
}

function publishJourneyAuthEvent(eventBus, { wallet, topic, timestamp, outcome }) {
  if (!eventBus?.publish) return;
  try {
    eventBus.publish({
      topic,
      source: "auth",
      phase: "identity",
      wallet,
      wallets: [wallet],
      timestamp,
      data: { outcome }
    });
  } catch {
    // Journey telemetry cannot change a successful SIWE exchange.
  }
}
