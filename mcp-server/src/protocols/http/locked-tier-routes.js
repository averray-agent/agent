import { ValidationError } from "../../core/errors.js";

export function createLockedTierRoutes({
  authMiddleware,
  depositPoolDoor,
  lockedTierService,
  readJsonBody,
  respond
}) {
  return async function handleLockedTierRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/locked-deposits/quote") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const poolInfo = await depositPoolDoor.getInfo(auth.wallet);
      respond(response, 200, await lockedTierService.quote(auth.wallet, payload, { poolInfo }));
      return true;
    }
    if (request.method === "POST" && pathname === "/locked-deposits/consent") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const poolInfo = await depositPoolDoor.getInfo(auth.wallet);
      respond(response, 201, await lockedTierService.createLock(auth.wallet, payload, { poolInfo }));
      return true;
    }
    const exitMatch = pathname.match(/^\/locked-deposits\/(0x[0-9a-fA-F]{64})\/exit$/u);
    if (request.method === "POST" && exitMatch) {
      const auth = await authMiddleware(request, url);
      // Consume and reject caller data rather than silently accepting fields
      // that might look like a fee, haircut, or alternate release path.
      const payload = await readJsonBody(request);
      if (Object.keys(payload ?? {}).length > 0) {
        throw new ValidationError("Locked-deposit early exit accepts no caller-supplied terms.");
      }
      respond(response, 200, await lockedTierService.requestExit(auth.wallet, exitMatch[1]));
      return true;
    }
    return false;
  };
}
