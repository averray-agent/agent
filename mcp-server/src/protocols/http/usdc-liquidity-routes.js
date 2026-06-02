export function createUsdcLiquidityRoutes({
  authMiddleware,
  respond,
  usdcLiquidityStatusService,
}) {
  return async function handleUsdcLiquidityRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/usdc-liquidity/status") {
      await authMiddleware(request, url, { requireRole: "admin" });
      respond(response, 200, await usdcLiquidityStatusService.getStatus());
      return true;
    }

    return false;
  };
}
