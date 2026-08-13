export function createEarningsDoorRoutes({
  authMiddleware,
  earningsDoor,
  readJsonBody,
  respond
}) {
  return async function handleEarningsDoorRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/account/position") {
      const auth = await authMiddleware(request, url);
      const asset = url.searchParams.get("asset")?.trim() || "USDC";
      respond(response, 200, await earningsDoor.getAccount(auth.wallet, asset));
      return true;
    }
    if (request.method === "POST" && pathname === "/account/withdraw/transactions") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, await earningsDoor.buildWithdrawTransactions(auth.wallet, payload));
      return true;
    }
    return false;
  };
}
