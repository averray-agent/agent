export class AppError extends Error {
  constructor(message, { name = "AppError", code = "internal_error", statusCode = 500, details = undefined } = {}) {
    super(message);
    this.name = name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = undefined) {
    super(message, { name: "ValidationError", code: "invalid_request", statusCode: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message, code = "not_found", details = undefined) {
    super(message, { name: "NotFoundError", code, statusCode: 404, details });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = "conflict", details = undefined) {
    super(message, { name: "ConflictError", code, statusCode: 409, details });
  }
}

export class ConfigError extends AppError {
  constructor(message, details = undefined) {
    super(message, { name: "ConfigError", code: "invalid_configuration", statusCode: 500, details });
  }
}

export class ExternalServiceError extends AppError {
  constructor(message, code = "upstream_failure", details = undefined) {
    super(message, { name: "ExternalServiceError", code, statusCode: 502, details });
  }
}

export class BlockchainRevertError extends AppError {
  constructor(message, details = undefined) {
    super(message, { name: "BlockchainRevertError", code: "blockchain_revert", statusCode: 409, details });
  }
}

export class InsufficientLiquidityError extends ConflictError {
  constructor(asset, details = undefined) {
    super(`Insufficient liquid balance for ${asset}`, "insufficient_liquidity", details);
    this.name = "InsufficientLiquidityError";
  }
}

export class BorrowCapacityExceededError extends ConflictError {
  constructor(asset, details = undefined) {
    super(`Borrow capacity exceeded for ${asset}`, "borrow_capacity_exceeded", details);
    this.name = "BorrowCapacityExceededError";
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required.", code = "unauthorized", details = undefined) {
    super(message, { name: "AuthenticationError", code, statusCode: 401, details });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Forbidden.", code = "forbidden", details = undefined) {
    super(message, { name: "AuthorizationError", code, statusCode: 403, details });
  }
}

export function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }

  const message = error?.message ?? "internal_error";
  return new AppError(message);
}
