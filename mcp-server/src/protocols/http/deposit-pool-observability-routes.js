export function createDepositPoolObservabilityRoutes({ depositPoolObservability, respond }) {
  return async function handleDepositPoolObservabilityRoute({ request, response, pathname }) {
    if (request.method !== "GET" || pathname !== "/monitor/deposit-pool") return false;
    respond(response, 200, await depositPoolObservability.getSnapshot());
    return true;
  };
}
