export function createCreditPoolRoutes({ authMiddleware, creditPoolDoor, readJsonBody, respond }) {
  return async function handleCreditPoolRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/credit") {
      const auth = await authMiddleware(request, url);
      respond(response, 200, await creditPoolDoor.getInfo(auth.wallet));
      return true;
    }
    if (request.method === "POST" && pathname === "/credit/transactions") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, await creditPoolDoor.buildTransactions(auth.wallet, payload));
      return true;
    }
    return false;
  };
}
