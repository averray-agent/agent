import { ConfigError } from "../core/errors.js";
import {
  PaymentSettlementError,
  PaymentSettlementOutcomeUnknownError,
  PaymentVerificationError
} from "./payment-errors.js";

export {
  PaymentSettlementError,
  PaymentSettlementOutcomeUnknownError,
  PaymentVerificationError
};

/**
 * Provider-neutral settlement port. Implementations receive the opaque payment
 * proof plus portable x402 terms and return only normalized domain records.
 *
 * @typedef {Object} SettlementAdapter
 * @property {(input: Object) => Promise<{authorizationId: string, payer: string, expiresAt?: string, verifiedAt: string}>} verify
 * @property {(input: Object) => Promise<{receiptId: string, network: string, payer: string, amount: string, settledAt: string, discovery?: Object}>} settle
 */

export function assertSettlementAdapter(adapter) {
  if (!adapter || typeof adapter.verify !== "function" || typeof adapter.settle !== "function") {
    throw new ConfigError(
      "Settlement adapter must implement verify() and settle()."
    );
  }
  return adapter;
}
