import { ValidationError } from "../../core/errors.js";

export function createXcmRequestRoutes({
  authMiddleware,
  ensureXcmRequestOwnership,
  respond,
  service,
}) {
  return async function handleXcmRequestRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/xcm/request") {
      return false;
    }

    const auth = await authMiddleware(request, url);
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!requestId) {
      throw new ValidationError("requestId is required.");
    }
    const record = await service.getXcmRequest(requestId);
    ensureXcmRequestOwnership(record, auth);
    respond(response, 200, record);
    return true;
  };
}
