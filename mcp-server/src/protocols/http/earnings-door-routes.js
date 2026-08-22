export function createEarningsDoorRoutes({
  authMiddleware,
  earningsDoor,
  eventBus,
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
      const intent = await earningsDoor.buildWithdrawTransactions(auth.wallet, payload);
      publishWithdrawalIntent(eventBus, auth.wallet, payload, intent);
      respond(response, 200, intent);
      return true;
    }
    return false;
  };
}

function publishWithdrawalIntent(eventBus, wallet, request, intent) {
  if (!eventBus?.publish) return;
  const timestamp = new Date().toISOString();
  try {
    eventBus.publish({
      topic: "journey.withdrawal_intent_created",
      source: "account",
      phase: "withdrawal",
      wallet,
      wallets: [wallet],
      timestamp,
      data: {
        status: "created",
        gasGrantRequested: request?.requestGasGrant === true,
        gasGrantStatus: typeof intent?.firstWithdrawalGasGrant?.status === "string"
          ? intent.firstWithdrawalGasGrant.status
          : "unknown",
        gasGrantReason: typeof intent?.firstWithdrawalGasGrant?.reason === "string"
          ? intent.firstWithdrawalGasGrant.reason
          : null
      }
    });
  } catch {
    // Journey telemetry cannot prevent a worker from receiving signable data.
  }
}
