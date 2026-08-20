import { keccak256, toUtf8Bytes } from "ethers";

export const PLATFORM_FAULT_REMEDIATION_KIND = "platform_fault_internal_remediation";
export const PLATFORM_FAULT_REMEDIATION_ORIGIN = "platform_fault";
export const PLATFORM_FAULT_REMEDIATION_REASON_CODE = "PLATFORM_FAULT_REMEDIATION";
export const PLATFORM_FAULT_REMEDIATION_PENDING = "awaiting_hardware_arbitrator";

export function platformFaultRemediationIdForSession(sessionId) {
  const normalized = String(sessionId ?? "").trim();
  if (!normalized) {
    throw new Error("platform fault remediation requires a sessionId");
  }
  return `platform-fault-${keccak256(toUtf8Bytes(normalized)).slice(2, 18)}`;
}

export function buildPlatformFaultRemediationMarker(record = {}) {
  return {
    kind: PLATFORM_FAULT_REMEDIATION_KIND,
    origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
    id: record.id,
    status: record.status,
    workerInitiated: false,
    workerConsequence: "none",
    queuedAt: record.queuedAt,
  };
}

export function isInternalPlatformFaultRemediation(value) {
  const marker = value?.internalRemediation ?? value?.platformFaultRemediation ?? value;
  return marker?.kind === PLATFORM_FAULT_REMEDIATION_KIND
    && marker?.origin === PLATFORM_FAULT_REMEDIATION_ORIGIN
    && marker?.workerInitiated === false;
}
