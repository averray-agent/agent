export function createDepositPoolObservabilityRoutes({ depositPoolObservability, respond }) {
  return async function handleDepositPoolObservabilityRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/monitor/deposit-pool") return false;
    respond(response, 200, await depositPoolObservability.getSnapshot({
      poolAddress: url?.searchParams.get("pool")?.trim() || undefined
    }));
    return true;
  };
}
