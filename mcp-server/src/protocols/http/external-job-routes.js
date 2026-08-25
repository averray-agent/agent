import { extractClientKey } from "../../auth/rate-limit.js";
import { AppError, AuthenticationError } from "../../core/errors.js";

export function createExternalJobRoutes({
  authMiddleware,
  enforceLimit,
  externalPostingService,
  x402PosterRamp,
  rateLimitConfig,
  readJsonBody,
  respond,
  trustProxy = false
}) {
  return async function handleExternalJobRoute({
    request,
    response,
    url,
    pathname
  }) {
    if (request.method === "POST" && pathname === "/jobs/x402") {
      try {
        if (!x402PosterRamp) {
          throw new AppError(
            "x402 job posting is not enabled on this deployment. Use the SIWE /jobs/draft flow, or retry after the operator enables the configured settlement and float policy.",
            {
              code: "x402_posting_disabled",
              statusCode: 503,
              details: {
                action: "use_siwe_draft_or_retry_after_enablement",
                posterFunds: "unchanged"
              }
            }
          );
        }
        await enforceLimit(
          "external_x402",
          extractClientKey(request, { trustProxy }),
          rateLimitConfig.externalDrafts
        );
        const payload = await readJsonBody(request);
        const paymentProof = firstHeader(
          request.headers?.["payment-signature"] ?? request.headers?.["x-payment"]
        );
        if (!paymentProof) {
          const challenge = await x402PosterRamp.paymentRequired(payload);
          respond(
            response,
            challenge.statusCode,
            challenge.body,
            challenge.headers
          );
          return true;
        }
        const result = await x402PosterRamp.post({
          payload,
          paymentProof,
          signInProof: firstHeader(request.headers?.["sign-in-with-x"])
        });
        const { headers, ...body } = result;
        respond(response, 200, body, headers);
        return true;
      } catch (error) {
        throw actionableX402Error(error);
      }
    }

    if (request.method === "POST" && pathname === "/jobs/draft") {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_drafts",
        auth.wallet,
        rateLimitConfig.externalDrafts
      );
      const payload = await readJsonBody(request);
      respond(
        response,
        200,
        await externalPostingService.createDraft(auth.wallet, payload)
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/poster/jobs") {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_drafts",
        auth.wallet,
        rateLimitConfig.externalDrafts
      );
      respond(
        response,
        200,
        await externalPostingService.listPosterJobs(auth.wallet)
      );
      return true;
    }

    const transactionMatch = pathname.match(/^\/jobs\/draft\/([^/]+)\/transactions$/u);
    if (request.method === "POST" && transactionMatch) {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_drafts",
        auth.wallet,
        rateLimitConfig.externalDrafts
      );
      respond(
        response,
        200,
        await externalPostingService.buildPostJobTransactions(
          auth.wallet,
          decodeURIComponent(transactionMatch[1])
        )
      );
      return true;
    }

    const draftMatch = pathname.match(/^\/jobs\/draft\/([^/]+)$/u);
    if (request.method === "GET" && draftMatch) {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_drafts",
        auth.wallet,
        rateLimitConfig.externalDrafts
      );
      respond(
        response,
        200,
        await externalPostingService.getDraft(
          auth.wallet,
          decodeURIComponent(draftMatch[1])
        )
      );
      return true;
    }

    const delistMatch = pathname.match(/^\/admin\/jobs\/external\/([^/]+)\/delist$/u);
    if (request.method === "POST" && delistMatch) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit(
        "admin_jobs",
        auth.wallet,
        rateLimitConfig.adminJobs
      );
      const payload = await readJsonBody(request);
      respond(
        response,
        200,
        await externalPostingService.delistExternalJob(
          decodeURIComponent(delistMatch[1]),
          { ...payload, adminWallet: auth.wallet }
        )
      );
      return true;
    }

    return false;
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function actionableX402Error(error) {
  if (error?.details?.action && error?.details?.posterFunds) return error;
  const statusCode = Number(error?.statusCode ?? 500);
  const beforeSettlement = statusCode >= 400 && statusCode < 500;
  const rateLimited = statusCode === 429;
  return new AppError(
    rateLimited
      ? `${String(error?.message ?? "The x402 request rate limit was reached.")} Wait until the advertised retry time, then request a fresh 402 response.`
      : beforeSettlement
      ? `${String(error?.message ?? "The x402 request was rejected.")} Correct the request as described, request a fresh 402 response, and retry.`
      : `${String(error?.message ?? "The x402 request failed.")} The payment outcome could not be confirmed; check the payer wallet and contact support with the request ID before retrying.`,
    {
      name: error?.name ?? "X402PostingError",
      code: error?.code ?? "x402_posting_failed",
      statusCode,
      details: {
        ...(error?.details ?? {}),
        action: rateLimited
          ? "wait_until_retry_time"
          : beforeSettlement
            ? "correct_request_and_retry_for_fresh_challenge"
            : "check_wallet_and_contact_support",
        posterFunds: beforeSettlement ? "unchanged" : "unknown"
      }
    }
  );
}

function requireSiweWalletSession(auth) {
  if (auth?.claims?.serviceToken === true || auth?.claims?.tokenKind === "service") {
    throw new AuthenticationError(
      "External job drafts require a SIWE wallet session.",
      "external_posting_siwe_required"
    );
  }
}
