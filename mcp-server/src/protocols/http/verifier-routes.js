export function createVerifierRoutes({
  authMiddleware,
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verifierService,
}) {
  async function authenticateVerifierRun(request, url, requireRole = "verifier") {
    const auth = await authMiddleware(request, url, { requireRole });
    await enforceLimit("verifier_run", auth.wallet, rateLimitConfig.verifierRun);
    return auth;
  }

  return async function handleVerifierRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/verifier/pending") {
      await authMiddleware(request, url, { requireRole: "admin" });
      respond(response, 200, await verifierService.githubPrReview.pending());
      return true;
    }
    if (request.method === "GET" && pathname === "/verifier/handlers") {
      respond(response, 200, { handlers: verifierService.listHandlers() });
      return true;
    }

    if (request.method === "GET" && pathname === "/verifier/result") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      respond(response, 200, await verifierService.getResult(sessionId) ?? { status: "not_found" });
      return true;
    }

    if (request.method === "GET" && pathname === "/verifier/pending") {
      // Verifier-scoped queue of submissions awaiting verification, so a verifier
      // doesn't need the admin-only /admin/sessions view to find pending work.
      await authMiddleware(request, url, { requireRole: "verifier" });
      const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      respond(response, 200, await verifierService.listPendingVerifications({ limit }));
      return true;
    }

    if (request.method === "POST" && pathname === "/verifier/replay") {
      await authenticateVerifierRun(request, url);
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      respond(response, 200, await verifierService.replayVerification(sessionId));
      return true;
    }

    if (request.method === "POST" && ["/verifier/run", "/admin/verifier/run"].includes(pathname)) {
      await authenticateVerifierRun(request, url, pathname.startsWith("/admin/") ? "admin" : "verifier");
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      const evidence = payload && typeof payload === "object" && "evidence" in payload
        ? payload.evidence
        : (url.searchParams.get("evidence") ?? "");
      const metadataURI = typeof payload?.metadataURI === "string" && payload.metadataURI.trim()
        ? payload.metadataURI.trim()
        : (url.searchParams.get("metadataURI") ?? "ipfs://pending-badge");
      respond(response, 200, await verifierService.verifySubmission({
        sessionId, evidence, metadataURI, ...(payload?.preview === true ? { preview: true } : {}),
        ...(payload?.expectOutcome !== undefined ? { expectOutcome: payload.expectOutcome } : {})
      }));
      return true;
    }

    return false;
  };
}
