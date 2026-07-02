import { ValidationError } from "./errors.js";
import { knownAssetMinBalanceRaw, normalizeAssetSymbol } from "./assets.js";
import { getJobSchema } from "./job-schema-registry.js";

export const DEFAULT_TREASURY_POLICY_STATUS = {
  enabled: false,
  policyAddress: undefined,
  paused: undefined,
  owner: undefined,
  pauser: undefined,
  settlementReady: false,
  contracts: {
    escrowCoreAddress: undefined,
    agentAccountAddress: undefined,
    reputationSbtAddress: undefined,
    supportedAssets: []
  },
  roles: {
    signerAddress: undefined,
    signerIsVerifier: false,
    signerIsSettlementBroker: false,
    escrowIsAgentAccountEscrowOperator: false,
    agentAccountIsOutflowRecorder: false
  },
  readErrors: [],
  risk: {}
};

export const DEFAULT_XCM_SETTLEMENT_WATCHER_STATUS = {
  enabled: false,
  running: false,
  pendingCount: 0,
  pending: []
};

export const DEFAULT_XCM_OBSERVATION_RELAY_STATUS = {
  enabled: false,
  running: false,
  syncing: false,
  feedUrl: undefined,
  batchSize: 0,
  pollIntervalMs: 0,
  cursor: undefined,
  lastObservedCount: 0,
  lastSyncedAt: undefined,
  lastError: undefined,
  updatedAt: undefined
};

export function sumSubJobRewards(jobs, asset) {
  const normalizedAsset = normalizeAssetSymbol(asset);
  return jobs
    .filter((job) => normalizeAssetSymbol(job.rewardAsset) === normalizedAsset)
    .reduce((total, job) => total + Math.max(Number(job.rewardAmount ?? 0), 0), 0);
}

export function minBalanceRawForAsset(asset) {
  if (!asset) {
    return undefined;
  }
  const raw = asset.minBalanceRaw ?? knownAssetMinBalanceRaw(asset);
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "bigint") {
    return raw >= 0n ? raw : undefined;
  }
  const value = String(raw).trim();
  return /^\d+$/u.test(value) ? BigInt(value) : undefined;
}

export function decimalToBaseUnits(amount, decimals, label) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new ValidationError(`${label} asset decimals must be an integer in [0, 30].`);
  }
  const normalized = normalizeDecimalString(amount, label);
  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > decimals) {
    throw new ValidationError(`${label} must fit ${decimals} decimal places.`);
  }
  return BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt(fractional.padEnd(decimals, "0") || "0");
}

export function formatBaseUnits(raw, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fractional = raw % scale;
  if (fractional === 0n || decimals === 0) return whole.toString();
  const padded = fractional.toString().padStart(decimals, "0").replace(/0+$/u, "");
  return `${whole}.${padded}`;
}

export async function getTreasuryPolicyStatusSafely(blockchainGateway) {
  if (!blockchainGateway?.getTreasuryPolicyStatus) {
    return { ...DEFAULT_TREASURY_POLICY_STATUS };
  }

  try {
    return await blockchainGateway.getTreasuryPolicyStatus();
  } catch (error) {
    return {
      ...DEFAULT_TREASURY_POLICY_STATUS,
      enabled: Boolean(blockchainGateway.isEnabled?.()),
      policyAddress: blockchainGateway.config?.treasuryPolicyAddress || undefined,
      error: {
        code: error?.code ?? "policy_status_error",
        message: error?.message ?? "Treasury policy status failed.",
        details: error?.details
      }
    };
  }
}

export async function getXcmSettlementWatcherStatusSafely(xcmSettlementWatcher) {
  if (!xcmSettlementWatcher?.getStatus) {
    return { ...DEFAULT_XCM_SETTLEMENT_WATCHER_STATUS };
  }

  try {
    return await xcmSettlementWatcher.getStatus();
  } catch (error) {
    return {
      ...DEFAULT_XCM_SETTLEMENT_WATCHER_STATUS,
      enabled: Boolean(xcmSettlementWatcher.enabled),
      running: Boolean(xcmSettlementWatcher.running),
      error: normalizeStatusReadError(error, "xcm_settlement_watcher_status_error")
    };
  }
}

export async function getXcmObservationRelayStatusSafely(xcmObservationRelay) {
  if (!xcmObservationRelay?.getStatus) {
    return { ...DEFAULT_XCM_OBSERVATION_RELAY_STATUS };
  }

  try {
    return await xcmObservationRelay.getStatus();
  } catch (error) {
    return {
      ...DEFAULT_XCM_OBSERVATION_RELAY_STATUS,
      enabled: Boolean(xcmObservationRelay.enabled),
      running: Boolean(xcmObservationRelay.running),
      syncing: Boolean(xcmObservationRelay.syncing),
      feedUrl: xcmObservationRelay.feedUrl,
      batchSize: xcmObservationRelay.batchSize ?? 0,
      pollIntervalMs: xcmObservationRelay.pollIntervalMs ?? 0,
      error: normalizeStatusReadError(error, "xcm_observation_relay_status_error")
    };
  }
}

export function buildSubmissionValidationContract(job) {
  const schemaRef = job?.outputSchemaRef;
  const schema = getJobSchema(schemaRef, { registrations: job?.schemaRegistrations });
  const requiredTopLevelKeys = Array.isArray(schema?.required) ? schema.required : [];
  return {
    validationEndpoint: "POST /jobs/validate-submission",
    submitEndpoint: "POST /jobs/submit",
    submissionShape: "direct_schema_object",
    schemaValidates: "payload.submission",
    doNotWrapInOutput: true,
    ...(requiredTopLevelKeys.length ? { requiredTopLevelKeys } : {})
  };
}

export function validationPathFromError(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const directPath = [
    details.path,
    details.expectedPath,
    details.expected,
    details.received
  ].find((entry) => typeof entry === "string" && entry.trim());
  if (directPath) {
    return normalizeValidationPath(directPath);
  }
  return normalizeValidationPath(parseValidationPathFromMessage(error?.message));
}

function normalizeDecimalString(value, label) {
  const raw = typeof value === "number"
    ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 30 })
    : String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
    throw new ValidationError(`${label} must be a positive decimal amount.`);
  }
  return raw;
}

function normalizeStatusReadError(error, code) {
  return {
    code: error?.code ?? code,
    message: error?.message ?? "Status read failed.",
    details: error?.details
  };
}

function parseValidationPathFromMessage(message) {
  if (typeof message !== "string") {
    return undefined;
  }
  const payloadMatch = message.match(/\bpayload\.submission(?:\.[A-Za-z0-9_-]+|\[[0-9]+\])*/u);
  if (payloadMatch) {
    return payloadMatch[0];
  }
  const submissionMatch = message.match(/\bsubmission(?:\.[A-Za-z0-9_-]+|\[[0-9]+\])*/u);
  if (submissionMatch) {
    return submissionMatch[0];
  }
  return undefined;
}

function normalizeValidationPath(path) {
  if (typeof path !== "string" || !path.trim()) {
    return undefined;
  }
  const trimmed = path.trim();
  return trimmed.startsWith("payload.") ? trimmed : `payload.${trimmed}`;
}
