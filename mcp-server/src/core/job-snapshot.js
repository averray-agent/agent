import { hashCanonicalContent } from "./canonical-content.js";
import { ConflictError } from "./errors.js";
import { getJobSchema } from "./job-schema-registry.js";
import { cloneJsonRecord } from "./state-store-records.js";

export const JOB_SNAPSHOT_VERSION = "job-snapshot-v1";

/**
 * Capture both the job the worker will execute and the exact definition whose
 * hash EscrowCore committed. They are normally identical. External jobs are
 * the exception: their catalogue projection adds platform-owned lifecycle and
 * funding metadata after the poster's definition has already been hashed.
 */
export function buildJobSnapshot(job, {
  specDefinition = job,
  claimEconomics = undefined,
  capturedAt = new Date().toISOString()
} = {}) {
  const definition = cloneJsonRecord(job);
  const spec = cloneJsonRecord(specDefinition);
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new ConflictError(
      "The claimable job cannot be pinned as a JSON definition.",
      "job_snapshot_capture_failed"
    );
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ConflictError(
      "The job's on-chain specification preimage is unavailable.",
      "job_snapshot_capture_failed"
    );
  }
  const outputSchemaRef = String(definition.outputSchemaRef ?? "").trim();
  const outputSchema = outputSchemaRef
    ? cloneJsonRecord(getJobSchema(outputSchemaRef, { registrations: definition.schemaRegistrations }))
    : undefined;
  return {
    version: JOB_SNAPSHOT_VERSION,
    capturedAt,
    jobId: String(definition.id ?? ""),
    definition,
    definitionHash: hashCanonicalContent(definition),
    specDefinition: spec,
    specHash: hashCanonicalContent(spec),
    outputSchema: outputSchema
      ? {
          ref: outputSchemaRef,
          schema: outputSchema,
          schemaHash: hashCanonicalContent(outputSchema)
        }
      : null,
    claimEconomics: cloneJsonRecord(claimEconomics)
  };
}

export function requireJobSnapshot(session) {
  const snapshot = session?.jobSnapshot;
  if (!snapshot || snapshot.version !== JOB_SNAPSHOT_VERSION) {
    throw integrityError(
      session,
      "job_snapshot_missing",
      "The session has no claim-time job snapshot and cannot be verified or settled automatically."
    );
  }
  if (
    !snapshot.definition
    || !snapshot.specDefinition
  ) {
    throw integrityError(
      session,
      "job_snapshot_incomplete",
      "The session's claim-time job snapshot is incomplete."
    );
  }

  if (snapshot.outputSchema?.schema) {
    const outputSchemaRef = String(snapshot.outputSchema.ref ?? "");
    const actualOutputSchemaHash = hashCanonicalContent(snapshot.outputSchema.schema);
    if (
      outputSchemaRef !== String(snapshot.definition.outputSchemaRef ?? "")
      || normalizeHash(snapshot.outputSchema.schemaHash) !== normalizeHash(actualOutputSchemaHash)
    ) {
      throw integrityError(
        session,
        "job_snapshot_output_schema_mismatch",
        "The session's resolved claim-time output schema was modified after it was pinned.",
        {
          expectedRef: snapshot.definition.outputSchemaRef,
          actualRef: outputSchemaRef,
          expectedHash: snapshot.outputSchema.schemaHash,
          actualHash: actualOutputSchemaHash
        }
      );
    }
  }

  const actualDefinitionHash = hashCanonicalContent(snapshot.definition);
  if (normalizeHash(snapshot.definitionHash) !== normalizeHash(actualDefinitionHash)) {
    throw integrityError(
      session,
      "job_snapshot_definition_hash_mismatch",
      "The session's claim-time job definition was modified after it was pinned.",
      { expected: snapshot.definitionHash, actual: actualDefinitionHash }
    );
  }

  const actualSpecHash = hashCanonicalContent(snapshot.specDefinition);
  if (normalizeHash(snapshot.specHash) !== normalizeHash(actualSpecHash)) {
    throw integrityError(
      session,
      "job_snapshot_spec_preimage_mismatch",
      "The session's pinned on-chain specification preimage was modified after claim.",
      { expected: snapshot.specHash, actual: actualSpecHash }
    );
  }

  const snapshotJobId = String(snapshot.jobId ?? "");
  const definitionJobId = String(snapshot.definition.id ?? "");
  if (!snapshotJobId || snapshotJobId !== String(session?.jobId ?? "") || definitionJobId !== snapshotJobId) {
    throw integrityError(
      session,
      "job_snapshot_job_id_mismatch",
      "The pinned job id does not match its session.",
      { snapshotJobId, definitionJobId, sessionJobId: session?.jobId }
    );
  }

  return {
    job: cloneJsonRecord(snapshot.definition),
    snapshot: cloneJsonRecord(snapshot),
    specHash: actualSpecHash
  };
}

/**
 * Assert the local pin first, then bind it to EscrowCore's immutable specHash.
 * A chain-enabled verifier must be able to perform this read; inability to
 * prove the terms is an integrity stop, never a verification verdict.
 */
export async function assertJobSnapshotIntegrity(session, gateway, { liveJob = undefined } = {}) {
  const pinned = requireJobSnapshot(session);
  if (!gateway?.isEnabled?.()) {
    return pinned;
  }
  if (typeof gateway.getJob !== "function") {
    throw integrityError(
      session,
      "job_snapshot_chain_read_unavailable",
      "The verifier cannot read the on-chain job needed to prove the pinned terms."
    );
  }

  const chainJobId = session.chainJobId ?? session.jobId;
  if (typeof gateway.toJobId === "function") {
    const derivedChainJobId = gateway.toJobId(pinned.snapshot.jobId);
    if (normalizeHash(derivedChainJobId) !== normalizeHash(chainJobId)) {
      throw integrityError(
        session,
        "job_snapshot_chain_job_id_mismatch",
        "The pinned job id does not reproduce the session's on-chain job id.",
        { chainJobId, derivedChainJobId }
      );
    }
  }

  let chainJob;
  try {
    chainJob = liveJob ?? await gateway.getJob(chainJobId);
  } catch (error) {
    throw integrityError(
      session,
      "job_snapshot_chain_read_failed",
      "The verifier could not read the on-chain job needed to prove the pinned terms.",
      { cause: error?.message ?? String(error) }
    );
  }
  const onChainSpecHash = normalizeHash(chainJob?.specHash);
  if (!/^0x[0-9a-f]{64}$/u.test(onChainSpecHash)) {
    throw integrityError(
      session,
      "job_snapshot_chain_spec_hash_missing",
      "The on-chain job does not expose a valid specHash.",
      { onChainSpecHash: chainJob?.specHash ?? null }
    );
  }
  if (normalizeHash(pinned.specHash) !== onChainSpecHash) {
    throw integrityError(
      session,
      "job_snapshot_on_chain_spec_hash_mismatch",
      "The pinned claim-time definition does not reproduce the on-chain specHash.",
      { pinnedSpecHash: pinned.specHash, onChainSpecHash }
    );
  }
  return { ...pinned, liveJob: chainJob };
}

export function isJobSnapshotIntegrityError(error) {
  return typeof error?.code === "string" && error.code.startsWith("job_snapshot_");
}

function integrityError(session, code, message, details = undefined) {
  return new ConflictError(message, code, {
    integrityFailure: true,
    operatorHandlingRequired: true,
    sessionId: session?.sessionId,
    jobId: session?.jobId,
    ...(details ?? {})
  });
}

function normalizeHash(value) {
  return String(value ?? "").toLowerCase();
}
