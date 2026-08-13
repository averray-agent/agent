export function createCreditPoolObservabilityRoutes({ creditPoolObservability, respond }) {
  return async function handleCreditPoolObservabilityRoute({ request, response, pathname }) {
    if (request.method !== "GET" || pathname !== "/monitor/credit-pool") return false;
    respond(response, 200, await creditPoolObservability.getSnapshot());
    return true;
  };
}
