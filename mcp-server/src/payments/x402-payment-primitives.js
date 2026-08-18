import { PaymentVerificationError } from "./payment-errors.js";

export function decodeX402PaymentProof(value, { fundsField = "posterFunds" } = {}) {
  const encoded = String(value ?? "").trim();
  if (!encoded) {
    throw new PaymentVerificationError(
      "PAYMENT-SIGNATURE (or X-PAYMENT) is required. Sign the advertised payment requirements and retry.",
      "payment_proof_required",
      { action: "sign_payment_requirements", [fundsField]: "unchanged" }
    );
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new PaymentVerificationError(
      "The payment header is not valid base64-encoded x402 JSON. Rebuild it from the latest 402 response and retry.",
      "payment_proof_malformed",
      { action: "rebuild_payment_header", [fundsField]: "unchanged" }
    );
  }
}

export function assertX402PaymentMatchesRequirements(
  payload,
  requirements,
  { fundsField = "posterFunds" } = {}
) {
  const accepted = payload?.accepted;
  const comparable = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"];
  if (Number(payload?.x402Version) !== 2 || !accepted) {
    throw new PaymentVerificationError(
      "The payment payload is not x402 v2. Rebuild it from the latest 402 response.",
      "payment_version_unsupported",
      { action: "use_latest_402_response", [fundsField]: "unchanged" }
    );
  }
  for (const field of comparable) {
    if (String(accepted[field] ?? "").toLowerCase() !== String(requirements?.[field] ?? "").toLowerCase()) {
      throw new PaymentVerificationError(
        `The payment payload changed the advertised ${field}. Rebuild it from the latest 402 response and do not edit payment terms.`,
        "payment_requirements_mismatch",
        { field, action: "use_unchanged_payment_requirements", [fundsField]: "unchanged" }
      );
    }
  }
  for (const field of ["name", "version", "profile", "requestHash"]) {
    if (String(accepted.extra?.[field] ?? "") !== String(requirements?.extra?.[field] ?? "")) {
      throw new PaymentVerificationError(
        `The payment payload changed the advertised extra.${field}. Rebuild it from the latest 402 response and do not edit payment terms.`,
        "payment_requirements_mismatch",
        { field: `extra.${field}`, action: "use_unchanged_payment_requirements", [fundsField]: "unchanged" }
      );
    }
  }
}

export function paymentRequiredHeaders(envelope) {
  const encoded = encodeX402Value(envelope);
  return {
    "payment-required": encoded,
    "x-payment-required": encoded
  };
}

export function paymentResponseHeaders({ transaction, network, payer, amount }) {
  const encoded = encodeX402Value({ success: true, transaction, network, payer, amount });
  return {
    "payment-response": encoded,
    "x-payment-response": encoded
  };
}

function encodeX402Value(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}
