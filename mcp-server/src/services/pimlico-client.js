import { ConfigError, ExternalServiceError, ValidationError } from "../core/errors.js";
import { loadPimlicoConfig } from "./pimlico-config.js";

export class PimlicoClient {
  constructor(config = loadPimlicoConfig()) {
    this.config = config;
  }

  isEnabled() {
    return this.config.enabled;
  }

  getCapabilities() {
    return {
      enabled: this.isEnabled(),
      bundlerUrl: this.config.bundlerUrl || undefined,
      paymasterUrl: this.config.paymasterUrl || undefined,
      entryPoint: this.config.entryPoint || undefined,
      sponsorshipPolicyId: this.config.sponsorshipPolicyId || undefined,
      chainId: this.config.chainId
    };
  }

  async healthCheck() {
    if (!this.isEnabled()) {
      return {
        ok: true,
        backend: "pimlico",
        enabled: false,
        mode: "disabled"
      };
    }

    try {
      const supportedEntryPoints = await this.rpc(this.config.bundlerUrl, "eth_supportedEntryPoints");
      const entryPointSupported = Array.isArray(supportedEntryPoints)
        && supportedEntryPoints.some((candidate) => `${candidate}`.toLowerCase() === this.config.entryPoint.toLowerCase());

      return {
        ok: entryPointSupported,
        backend: "pimlico",
        enabled: true,
        bundlerReachable: true,
        paymasterConfigured: Boolean(this.config.paymasterUrl),
        entryPoint: this.config.entryPoint,
        supportedEntryPoints
      };
    } catch (error) {
      return {
        ok: false,
        backend: "pimlico",
        enabled: true,
        bundlerReachable: false,
        paymasterConfigured: Boolean(this.config.paymasterUrl),
        entryPoint: this.config.entryPoint,
        error: error?.message ?? "pimlico_health_failed"
      };
    }
  }

  async quoteUserOperation(userOperation) {
    this.requireEnabled("quoteUserOperation");
    this.requireUserOperation(userOperation);

    const [gasPrice, gasEstimate] = await Promise.all([
      this.rpc(this.config.bundlerUrl, "pimlico_getUserOperationGasPrice"),
      this.rpc(this.config.bundlerUrl, "eth_estimateUserOperationGas", [userOperation, this.config.entryPoint])
    ]);

    return {
      entryPoint: this.config.entryPoint,
      gasPrice,
      gasEstimate
    };
  }

  async sponsorUserOperation(userOperation, context = {}) {
    this.requireEnabled("sponsorUserOperation");
    this.requireUserOperation(userOperation);

    const requestContext = {
      ...context
    };

    if (this.config.sponsorshipPolicyId && !requestContext.sponsorshipPolicyId) {
      requestContext.sponsorshipPolicyId = this.config.sponsorshipPolicyId;
    }

    const params = [userOperation, this.config.entryPoint];
    if (Object.keys(requestContext).length > 0) {
      params.push(requestContext);
    }

    return this.rpc(this.config.paymasterUrl, "pm_sponsorUserOperation", params);
  }

  requireEnabled(operation) {
    if (!this.isEnabled()) {
      throw new ConfigError(`${operation} requires Pimlico configuration.`);
    }
  }

  requireUserOperation(userOperation) {
    if (!userOperation || typeof userOperation !== "object" || Array.isArray(userOperation)) {
      throw new ValidationError("userOperation payload is required.");
    }
    // ERC-4337 user operations are a fixed-shape object. Reject missing or
    // non-string entries early instead of forwarding malformed calldata to the
    // bundler (which returns an opaque JSON-RPC error).
    const requiredHexFields = [
      "sender",
      "nonce",
      "callData",
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "signature"
    ];
    for (const field of requiredHexFields) {
      const value = userOperation[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new ValidationError(`userOperation.${field} is required and must be a non-empty string.`);
      }
      if (value.length > 32 * 1024) {
        throw new ValidationError(`userOperation.${field} exceeds 32KiB; likely malformed.`);
      }
    }
    // Optional fields, if present, must still be strings to keep the bundler
    // request schema-valid.
    for (const optionalField of ["initCode", "paymasterAndData"]) {
      if (optionalField in userOperation && typeof userOperation[optionalField] !== "string") {
        throw new ValidationError(`userOperation.${optionalField} must be a string when provided.`);
      }
    }
  }

  async rpc(url, method, params = []) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      })
    });

    if (!response.ok) {
      throw new ExternalServiceError(`${method} failed with HTTP ${response.status}`, "pimlico_unavailable", {
        method,
        status: response.status
      });
    }

    const payload = await response.json();
    if (payload?.error) {
      throw new ExternalServiceError(
        `${method} failed: ${payload.error.message ?? "unknown_error"}`,
        "pimlico_rpc_error",
        {
          method,
          error: payload.error
        }
      );
    }

    return payload?.result;
  }
}
