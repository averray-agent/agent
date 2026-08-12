export function createDepositPoolRoutes({
  authMiddleware,
  depositPoolDoor,
  readJsonBody,
  respond
}) {
  return async function handleDepositPoolRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/pool") {
      const hasBearer = /^Bearer\s+\S+/iu.test(String(request.headers?.authorization ?? ""));
      const auth = hasBearer ? await authMiddleware(request, url) : undefined;
      respond(response, 200, await depositPoolDoor.getInfo(auth?.wallet));
      return true;
    }
    if (request.method === "POST" && pathname === "/pool/transactions") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, await depositPoolDoor.buildTransactions(auth.wallet, payload));
      return true;
    }
    return false;
  };
}
