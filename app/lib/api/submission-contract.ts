import type {
  JobDefinition,
  JobSchemaContract,
  PreflightResponse,
  SubmissionContract,
  ValidationResponse,
} from "../../../sdk/agent-platform-client.js";

export type {
  JobSchemaContract,
  SubmissionContract,
  ValidationResponse,
};

export interface SubmissionValidationState {
  status: "not_checked" | "valid" | "invalid";
  message?: string;
  path?: string;
  details?: unknown;
}

export function extractSubmissionContract(
  ...payloads: unknown[]
): SubmissionContract | undefined {
  for (const payload of payloads) {
    const record = asRecord(payload) as
      | Partial<JobDefinition>
      | Partial<PreflightResponse>
      | null;
    const contract = asRecord(record?.submissionContract);
    if (contract) {
      return contract as SubmissionContract;
    }
  }
  return undefined;
}

export function extractJobSchemaContract(
  ...payloads: unknown[]
): JobSchemaContract | null {
  for (const payload of payloads) {
    const record = asRecord(payload) as
      | Partial<JobDefinition>
      | Partial<PreflightResponse>
      | null;
    const contract = asRecord(record?.schemaContract);
    if (contract) {
      return contract as JobSchemaContract;
    }
  }
  return null;
}

export function extractSubmissionExample(
  contract: SubmissionContract | undefined
): Record<string, unknown> | null {
  return asRecord(contract?.submitPayloadExample?.submission);
}

export function validationStateFromPayload(
  payload: unknown
): SubmissionValidationState {
  const record = asRecord(payload) as ValidationResponse | null;
  if (!record) {
    return {
      status: "invalid",
      message: "Validation endpoint returned an unexpected response.",
      details: payload,
    };
  }
  if (record.valid === true) return { status: "valid" };
  return {
    status: "invalid",
    message:
      text(record.message) || "Draft does not match the output schema.",
    path: validationPath(record),
    details: record.details ?? record,
  };
}

export function validationPath(record: Record<string, unknown>): string | undefined {
  const details = asRecord(record.details);
  return (
    text(record.path) ||
    text(record.expectedPath) ||
    text(record.expected) ||
    text(details?.path) ||
    text(details?.expectedPath) ||
    text(details?.expected) ||
    text(details?.received) ||
    undefined
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
