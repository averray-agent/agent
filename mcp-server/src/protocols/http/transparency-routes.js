export function createTransparencyRoutes({ authMiddleware, respond, transparencyService }) {
  return async function handleTransparencyRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/transparency") return false;

    await authMiddleware(request, url, { requireCapability: "ops:view" });
    respond(response, 200, await transparencyService.getSnapshot());
    return true;
  };
}
