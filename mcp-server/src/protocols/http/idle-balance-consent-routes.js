import { ValidationError } from "../../core/errors.js";

export function createIdleBalanceConsentRoutes({
  authMiddleware,
  idleBalanceConsentService,
  idleBalanceAllocationKeeper,
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
      respond(response, 200, await idleBalanceConsentService.quote(auth.wallet, payload));
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
    if (request.method === "POST" && pathname === "/account/idle-allocation/deallocate") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const fields = Object.keys(payload ?? {});
      if (fields.length !== 1 || fields[0] !== "amountRaw") {
        throw new ValidationError("Idle-balance deallocation accepts exactly amountRaw in USDC base units.");
      }
      const result = await idleBalanceAllocationKeeper.deallocate(auth.wallet, payload);
      respond(response, result.status === "queued" ? 202 : 200, result);
      return true;
    }
    return false;
  };
}
