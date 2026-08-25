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
        decorateQueuedRun(
          decorateVerificationRunPresentation(
            await verificationRunService.getRun(decodeURIComponent(runMatch[1])),
            { env: presentationEnv }
          )
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
      respond(
        response,
        200,
        decorateQueuedRun(
          decorateVerificationRunPresentation(run, { env: presentationEnv })
        ),
        headers
      );
      return true;
    }

    return false;
  };
}

function decorateQueuedRun(run) {
  if (run?.status !== "queued") return run;
  return {
    ...run,
    asyncStatus: {
      meaning: "Queued means the request was accepted for asynchronous verification. It is neither a failure nor a completed purchase.",
      poll: { method: "GET", path: `/verify/runs/${encodeURIComponent(run.runId)}` },
      settlement: "The settlement transaction is absent while queued. For a PASS, it appears only after PASS completes and payment capture succeeds."
    }
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
