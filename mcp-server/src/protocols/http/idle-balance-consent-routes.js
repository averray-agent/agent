import { ValidationError } from "../../core/errors.js";

export function createIdleBalanceConsentRoutes({
  authMiddleware,
  idleBalanceConsentService,
  readJsonBody,
  respond
}) {
  return async function handleIdleBalanceConsentRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/account/idle-allocation") {
      const auth = await authMiddleware(request, url);
      respond(response, 200, await idleBalanceConsentService.getStatus(auth.wallet));
      return true;
    }
    if (request.method === "POST" && pathname === "/account/idle-allocation/quote") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, idleBalanceConsentService.quote(auth.wallet, payload));
      return true;
    }
    if (request.method === "POST" && pathname === "/account/idle-allocation/consent") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 201, await idleBalanceConsentService.captureConsent(auth.wallet, payload));
      return true;
    }
    if (request.method === "POST" && pathname === "/account/idle-allocation/revoke") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      if (Object.keys(payload ?? {}).length > 0) {
        throw new ValidationError("Idle-balance consent revocation accepts no caller-supplied terms.");
      }
      respond(response, 200, await idleBalanceConsentService.revokeConsent(auth.wallet));
      return true;
    }
    return false;
  };
}
