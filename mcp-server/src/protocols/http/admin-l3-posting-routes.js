export function createAdminL3PostingRoutes({
  authMiddleware,
  l3PostingKeeper,
  parseLimit,
  readJsonBody,
  respond
}) {
  return async function handleAdminL3PostingRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/l3-posting/requests") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      const items = await l3PostingKeeper.list({
        borrower: url.searchParams.get("borrower") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: parseLimit(url, 50, 250)
      });
      respond(response, 200, { items, count: items.length });
      return true;
    }

    if (request.method === "GET" && pathname === "/admin/l3-posting/refusals") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      const items = await l3PostingKeeper.listRefusals({
        reason: url.searchParams.get("reason") ?? undefined,
        limit: parseLimit(url, 50, 250)
      });
      respond(response, 200, { items, count: items.length });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/l3-posting/requests") {
      await authMiddleware(request, url, { requireCapability: "credit:originate" });
      respond(response, 202, await l3PostingKeeper.enqueue(await readJsonBody(request)));
      return true;
    }

    const action = pathname.match(/^\/admin\/l3-posting\/requests\/([^/]+)\/(advance|reconcile)$/u);
    if (request.method === "POST" && action) {
      await authMiddleware(request, url, { requireCapability: "credit:originate" });
      const id = decodeURIComponent(action[1]);
      const result = action[2] === "advance"
        ? await l3PostingKeeper.advance(id)
        : await l3PostingKeeper.reconcile(id);
      respond(response, 200, result);
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/l3-posting/sweep") {
      await authMiddleware(request, url, { requireCapability: "credit:originate" });
      const payload = await readJsonBody(request);
      respond(response, 200, await l3PostingKeeper.sweep(payload));
      return true;
    }

    return false;
  };
}
