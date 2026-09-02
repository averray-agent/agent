export function createGasRoutes({
  authMiddleware,
  pimlicoClient,
  readJsonBody,
  respond,
}) {
  return async function handleGasRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/gas/health") {
      respond(response, 200, await pimlicoClient.healthCheck());
      return true;
    }

    if (request.method === "GET" && pathname === "/gas/capabilities") {
      respond(response, 200, pimlicoClient.getCapabilities());
      return true;
    }

    if (request.method === "POST" && pathname === "/gas/quote") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, await pimlicoClient.quoteUserOperation(payload.userOperation));
      return true;
    }

    if (request.method === "POST" && pathname === "/gas/sponsor") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(
        response,
        200,
        await pimlicoClient.sponsorUserOperation(payload.userOperation, payload.context ?? {})
      );
      return true;
    }

    return false;
  };
}
