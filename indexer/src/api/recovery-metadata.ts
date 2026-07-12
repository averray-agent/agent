export const PONDER_SCHEMA_IDENTITY_MISMATCH = "ponder_schema_identity_mismatch";

type RecoveryEnv = Record<string, string | undefined>;

export function readIndexerRecoveryMetadata(env: RecoveryEnv = process.env) {
  if (env.INDEXER_LAST_STARTUP_ERROR !== PONDER_SCHEMA_IDENTITY_MISMATCH) {
    return undefined;
  }

  const recoveredAt = env.INDEXER_LAST_RECOVERY_AT?.trim();
  const previousSchema = validSchema(env.INDEXER_LAST_RECOVERY_FROM_SCHEMA);
  const currentSchema = validSchema(env.INDEXER_LAST_RECOVERY_TO_SCHEMA);
  if (!recoveredAt || !Number.isFinite(Date.parse(recoveredAt)) || !previousSchema || !currentSchema) {
    return undefined;
  }

  return {
    startupError: {
      code: PONDER_SCHEMA_IDENTITY_MISMATCH,
      message: "Ponder rejected a schema owned by a different app build identity."
    },
    recoveredAt,
    previousSchema,
    currentSchema,
    backupFile: safeBasename(env.INDEXER_LAST_RECOVERY_BACKUP)
  };
}

function validSchema(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[a-z_][a-z0-9_]{0,62}$/.test(normalized)
    ? normalized
    : undefined;
}

function safeBasename(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9_.-]+$/.test(normalized)) return undefined;
  return normalized;
}
