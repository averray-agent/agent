import { extractClientKey } from "../../auth/rate-limit.js";

export function createVerifyRoutes({
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verificationRunService,
  trustProxy = false
}) {
  return async function handleVerifyRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/verify/profiles") {
      respond(response, 200, { profiles: verificationRunService.listProfiles() }, {
        "cache-control": "public, max-age=300"
      });
      return true;
    }

    const runMatch = pathname.match(/^\/verify\/runs\/([^/]+)$/u);
    if (request.method === "GET" && runMatch) {
      respond(
        response,
        200,
        await verificationRunService.getRun(decodeURIComponent(runMatch[1]))
      );
      return true;
    }

    if (request.method === "POST" && pathname === "/verify/runs") {
      await enforceLimit(
        "verify_runs",
        extractClientKey(request, { trustProxy }),
        rateLimitConfig.verifierRun
      );
      const payload = await readJsonBody(request);
      const paymentProof = firstHeader(request.headers?.["verification-payment"]);
      respond(response, 200, await verificationRunService.createRun({
        profile: payload?.profile,
        profileVersion: payload?.profileVersion,
        target: payload?.target,
        inputs: payload?.inputs,
        paymentProof: paymentProof || undefined
      }));
      return true;
    }

    return false;
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}
