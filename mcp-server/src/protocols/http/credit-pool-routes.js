import { CREDIT_INTEREST_STATEMENT } from "../../core/worker-progression.js";

export function createCreditPoolRoutes({
  authMiddleware,
  creditPoolDoor,
  creditBookDoor,
  workerProgressionService,
  readJsonBody,
  respond
}) {
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
    if (request.method === "POST" && pathname === "/credit/consent") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      respond(response, 200, await creditBookDoor.storeConsent(auth.wallet, payload));
      return true;
    }
    if (request.method === "POST" && pathname === "/credit/interest") {
      const auth = await authMiddleware(request, url);
      const registration = await workerProgressionService.registerCreditInterest(auth.wallet);
      respond(response, 200, { ...registration, statement: CREDIT_INTEREST_STATEMENT });
      return true;
    }
    return false;
  };
}
