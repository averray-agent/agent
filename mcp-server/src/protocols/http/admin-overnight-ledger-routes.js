export function createAdminOvernightLedgerRoutes({
  authMiddleware,
  overnightLedger,
  respond
}) {
  return async function handleAdminOvernightLedgerRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/ops/overnight-ledger") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      respond(response, 200, await overnightLedger.getLedger(url.searchParams.get("window") ?? "24h"));
      return true;
    }

    if (request.method === "GET" && pathname === "/admin/ops/topup-destinations") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      respond(response, 200, overnightLedger.getTopupDestinations());
      return true;
    }

    return false;
  };
}
