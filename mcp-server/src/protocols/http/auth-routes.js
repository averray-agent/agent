import { randomBytes } from "node:crypto";

import { AuthenticationError, ValidationError } from "../../core/errors.js";
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
const SIGNATURE_RE = /^(0x)?[0-9a-fA-F]{130,132}$/u;

function generateNonce(randomBytesImpl) {
  return randomBytesImpl(16).toString("hex");
}

function walletsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
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
    capabilities: authCapabilities.resolveCapabilities({ roles }),
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

  return async function handleAuthRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/auth/nonce") {
      await enforceLimit("auth_nonce", clientIp(request), rateLimitConfig.authNonce);
      const payload = await readJsonBody(request);
      const wallet = String(payload?.wallet ?? "").trim();
      if (!WALLET_RE.test(wallet)) {
        throw new ValidationError("wallet must be a 0x-prefixed 20-byte hex address.");
      }
      const nonce = generateNonce(randomBytesImpl);
      const stored = await stateStore.storeNonce?.(nonce, wallet.toLowerCase(), authConfig.nonceTtlSeconds);
      if (stored === false) {
        throw new ValidationError("Nonce collision — retry.");
      }
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + authConfig.nonceTtlSeconds * 1000).toISOString();
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
      if (!SIGNATURE_RE.test(signature)) {
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

      const consumedWallet = await stateStore.consumeNonce?.(verified.nonce);
      if (!consumedWallet) {
        throw new AuthenticationError("Nonce missing or already consumed.", "invalid_nonce");
      }
      if (!walletsMatch(consumedWallet, verified.recoveredAddress)) {
        throw new AuthenticationError("Nonce was issued for a different wallet.", "nonce_wallet_mismatch");
      }

      // ethers' signature recovery returns the EIP-55 *checksummed* address,
      // but the canonical wallet form across the platform is lowercase: every
      // JWT `sub` is minted lowercase and KmsJwtSigner.verify REJECTS a non-
      // lowercase `sub` ("sub claim must be lowercase" → 401 claims_mismatch).
      // Normalize once here so the access-token `sub`, the refresh record
      // (whose wallet seeds future `sub`s on /auth/refresh), and the response
      // wallet all use the canonical lowercase form. Without this, /auth/verify
      // returns 200 yet every authed call with the minted token self-rejects.
      const wallet = verified.recoveredAddress.toLowerCase();

      const roles = authConfig.resolveRoles?.(wallet) ?? [];
      const { token, claims } = await signTokenFromConfigImpl(
        { sub: wallet, roles },
        { expiresInSeconds: authConfig.tokenTtlSeconds },
        authConfig,
      );

      let setCookieHeader = null;
      try {
        if (supportsRefreshStore(stateStore)) {
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

      return respondHandled(
        response,
        200,
        buildTokenResponse({
          token,
          claims,
          wallet,
          roles,
          authCapabilities,
        }),
        setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}
      );
    }

    if (request.method === "GET" && pathname === "/auth/session") {
      const auth = await authMiddleware(request, url);
      return respondHandled(response, 200, {
        wallet: auth.wallet,
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
          wallet: auth.wallet,
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

      const roles = authConfig.resolveRoles?.(auth.wallet) ?? auth.claims?.roles ?? [];
      // auth.wallet derives from a verified token's `sub`, which the verifier
      // already enforces lowercase — lowercased here too to keep the "every
      // minted sub is lowercase" invariant explicit at every mint site.
      const { token, claims } = await signTokenFromConfigImpl(
        { sub: auth.wallet.toLowerCase(), roles },
        { expiresInSeconds: authConfig.tokenTtlSeconds },
        authConfig,
      );

      return respondHandled(response, 200, buildTokenResponse({
        token,
        claims,
        wallet: auth.wallet,
        roles,
        authCapabilities,
        extra: { rotatedFromJti: oldJti }
      }));
    }

    return false;
  };
}
