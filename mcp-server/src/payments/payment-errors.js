import { AppError } from "../core/errors.js";

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
