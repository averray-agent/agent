export function createAdminCreditRoutes({ authMiddleware, creditBookDoor, readJsonBody, respond }) {
  return async function handleAdminCreditRoute({ request, response, url, pathname }) {
    if (request.method !== "POST" || pathname !== "/admin/credit/originate") return false;
    await authMiddleware(request, url, { requireCapability: "credit:originate" });
    const payload = await readJsonBody(request);
    respond(response, 200, await creditBookDoor.originateConsentedLoan(payload?.termsHash));
    return true;
  };
}
