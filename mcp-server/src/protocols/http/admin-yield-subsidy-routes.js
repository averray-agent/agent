import { ValidationError } from "../../core/errors.js";

function onlyTxHash(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("The request body must be an object containing txHash.");
  }
  for (const field of Object.keys(payload)) {
    if (field !== "txHash") throw new ValidationError(`Unsupported field '${field}'.`, { field });
  }
  return { txHash: payload.txHash };
}

export function createAdminYieldSubsidyRoutes({
  authMiddleware,
  readJsonBody,
  respond,
  yieldAttributionService
}) {
  return async function handleAdminYieldSubsidyRoute({ request, response, url, pathname }) {
    if (pathname !== "/admin/deposit-pool/subsidies") return false;
    if (request.method === "GET") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      respond(response, 200, await yieldAttributionService.getLedger());
      return true;
    }
    if (request.method === "POST") {
      const auth = await authMiddleware(request, url, { requireCapability: "admin:yield-subsidy:attest" });
      const payload = onlyTxHash(await readJsonBody(request));
      const result = await yieldAttributionService.attestSubsidy({ ...payload, attestedBy: auth.wallet });
      respond(response, result.created ? 201 : 200, result);
      return true;
    }
    return false;
  };
}
