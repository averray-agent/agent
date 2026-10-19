import { editAdminOurs } from "../../core/self-identity-registry.js";

const PATH = "/admin/self-identity/ours";

export function createAdminSelfIdentityRoutes({
  authMiddleware,
  readJsonBody,
  respond,
  service,
  stateStore,
  logger = console
}) {
  return async function handleAdminSelfIdentityRoute({ request, response, url, pathname }) {
    if (pathname !== PATH) return false;
    if (request.method !== "POST") return false;
    const auth = await authMiddleware(request, url, { requireCapability: "admin:self-identity" });
    const payload = await readJsonBody(request);
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const edited = await editAdminOurs(stateStore, {
      action: body.action,
      wallet: body.wallet,
      label: body.label,
      purpose: body.purpose,
      reason: body.reason,
      addedBy: auth?.wallet,
      logger
    });
    service?.selfIdentityRegistry?.replaceAdminOurs(edited.wallets);
    respond(response, 200, {
      action: edited.action,
      label: edited.label,
      count: edited.count
    });
    return true;
  };
}
