import { AppError, ConfigError } from "../core/errors.js";

/**
 * Provider-neutral settlement port. Implementations receive the opaque payment
 * proof plus portable x402 terms and return only normalized domain records.
 *
 * @typedef {Object} SettlementAdapter
 * @property {(input: Object) => Promise<{authorizationId: string, payer: string, expiresAt?: string, verifiedAt: string}>} verify
 * @property {(input: Object) => Promise<{receiptId: string, network: string, payer: string, amount: string, settledAt: string, discovery?: Object}>} settle
 */

export class PaymentVerificationError extends AppError {
  constructor(message, code = "payment_verification_failed", details = undefined) {
    super(message, {
      name: "PaymentVerificationError",
      code,
      statusCode: 402,
      details
    });
  }
}

export class PaymentSettlementError extends AppError {
  constructor(message, code = "payment_settlement_failed", details = undefined) {
    super(message, {
      name: "PaymentSettlementError",
      code,
      statusCode: 502,
      details
    });
  }
}

export class PaymentSettlementOutcomeUnknownError extends AppError {
  constructor(message, details = undefined) {
    super(message, {
      name: "PaymentSettlementOutcomeUnknownError",
      code: "payment_settlement_outcome_unknown",
      statusCode: 502,
      details
    });
  }
}

export function assertSettlementAdapter(adapter) {
  if (!adapter || typeof adapter.verify !== "function" || typeof adapter.settle !== "function") {
    throw new ConfigError(
      "Settlement adapter must implement verify() and settle()."
    );
  }
  return adapter;
}
