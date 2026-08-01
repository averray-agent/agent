import { AuthenticationError } from "../../core/errors.js";

export function createExternalJobRoutes({
  authMiddleware,
  enforceLimit,
  externalPostingService,
  rateLimitConfig,
  readJsonBody,
  respond
}) {
  return async function handleExternalJobRoute({
    request,
    response,
    url,
    pathname
  }) {
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
        201,
        await externalPostingService.createDraft(auth.wallet, payload)
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

function requireSiweWalletSession(auth) {
  if (auth?.claims?.serviceToken === true || auth?.claims?.tokenKind === "service") {
    throw new AuthenticationError(
      "External job drafts require a SIWE wallet session.",
      "external_posting_siwe_required"
    );
  }
}
