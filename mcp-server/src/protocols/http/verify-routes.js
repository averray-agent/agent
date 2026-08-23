import { extractClientKey } from "../../auth/rate-limit.js";
import { decorateVerificationRunPresentation } from "../../core/verdict-presentation.js";
import { paymentResponseHeaders } from "../../payments/x402-payment-primitives.js";

export function createVerifyRoutes({
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verificationRunService,
  presentationEnv = process.env,
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
        decorateVerificationRunPresentation(
          await verificationRunService.getRun(decodeURIComponent(runMatch[1])),
          { env: presentationEnv }
        )
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
      const paymentProof = firstHeader(request.headers?.["payment-signature"])
        || firstHeader(request.headers?.["x-payment"])
        || firstHeader(request.headers?.["verification-payment"]);
      const ephemeralCredential = bearerCredential(
        firstHeader(request.headers?.["verification-target-authorization"])
      );
      let run;
      try {
        run = await verificationRunService.createRun({
          profile: payload?.profile,
          profileVersion: payload?.profileVersion,
          target: payload?.target,
          inputs: payload?.inputs,
          paymentProof: paymentProof || undefined,
          ephemeralCredential
        });
      } catch (error) {
        if (error?.statusCode === 402 && error?.details?.paymentRequired) {
          respond(
            response,
            402,
            error.details.paymentRequired,
            error.details.paymentRequiredHeaders
          );
          return true;
        }
        throw error;
      }
      const headers = run.billing?.status === "captured" && run.billing?.transactionHash
        ? paymentResponseHeaders({
            transaction: run.billing.transactionHash,
            network: run.billing.network,
            payer: run.customer,
            amount: run.billing.amountRaw
          })
        : undefined;
      respond(response, 200, decorateVerificationRunPresentation(run, { env: presentationEnv }), headers);
      return true;
    }

    return false;
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function bearerCredential(value) {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+([^\s]+)$/u);
  return match?.[1] ?? "";
}
