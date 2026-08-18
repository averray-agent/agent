import { extractClientKey } from "../../auth/rate-limit.js";
import { AppError } from "../../core/errors.js";
import { actionableVerifyPaymentError } from "../../payments/x402-verify-intake.js";

export function createVerifyRoutes({
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verificationRunService,
  x402VerifyIntake,
  trustProxy = false
}) {
  return async function handleVerifyRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/verify/profiles") {
      respond(response, 200, { profiles: verificationRunService.listProfiles() });
      return true;
    }

    const runMatch = pathname.match(/^\/verify\/runs\/(verify_[a-f0-9]{64})$/u);
    if (request.method === "GET" && runMatch) {
      respond(response, 200, await verificationRunService.getRun(runMatch[1]));
      return true;
    }

    if (request.method === "POST" && pathname === "/verify/runs") {
      if (!x402VerifyIntake) {
        throw new AppError(
          "Averray Verify payment intake is not enabled on this deployment.",
          { code: "verify_intake_disabled", statusCode: 503 }
        );
      }
      await enforceLimit(
        "verify_runs",
        extractClientKey(request, { trustProxy }),
        rateLimitConfig.verifyRuns
      );
      const payload = await readJsonBody(request);
      const paymentProof = firstHeader(
        request.headers?.["payment-signature"] ?? request.headers?.["x-payment"]
      );
      if (!paymentProof) {
        const challenge = x402VerifyIntake.paymentRequired(payload);
        respond(response, challenge.statusCode, challenge.body, challenge.headers);
        return true;
      }
      try {
        const result = await x402VerifyIntake.run({ payload, paymentProof });
        respond(response, result.statusCode, result.body, result.headers);
      } catch (error) {
        throw actionableVerifyPaymentError(error);
      }
      return true;
    }
    return false;
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}
