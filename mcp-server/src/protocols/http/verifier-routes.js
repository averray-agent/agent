export function createVerifierRoutes({
  authMiddleware,
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verifierService,
}) {
  async function authenticateVerifierRun(request, url) {
    const auth = await authMiddleware(request, url, { requireRole: "verifier" });
    await enforceLimit("verifier_run", auth.wallet, rateLimitConfig.verifierRun);
    return auth;
  }

  return async function handleVerifierRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/verifier/handlers") {
      respond(response, 200, { handlers: verifierService.listHandlers() });
      return true;
    }

    if (request.method === "GET" && pathname === "/verifier/result") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      respond(response, 200, await verifierService.getResult(sessionId) ?? { status: "not_found" });
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

    if (request.method === "POST" && pathname === "/verifier/run") {
      await authenticateVerifierRun(request, url);
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
      respond(response, 200, await verifierService.verifySubmission({ sessionId, evidence, metadataURI }));
      return true;
    }

    return false;
  };
}
