import assert from "node:assert/strict";
import test from "node:test";

import {
  PONDER_SCHEMA_IDENTITY_MISMATCH,
  readIndexerRecoveryMetadata
} from "./recovery-metadata.ts";

test("recovery metadata exposes the fixed Ponder startup cause after a valid self-heal", () => {
  assert.deepEqual(readIndexerRecoveryMetadata({
    INDEXER_LAST_STARTUP_ERROR: PONDER_SCHEMA_IDENTITY_MISMATCH,
    INDEXER_LAST_RECOVERY_AT: "2026-07-12T14:34:22Z",
    INDEXER_LAST_RECOVERY_FROM_SCHEMA: "agent_indexer_20260516080108",
    INDEXER_LAST_RECOVERY_TO_SCHEMA: "agent_indexer_20260712143422",
    INDEXER_LAST_RECOVERY_BACKUP: "indexer-schema-agent_indexer_20260516080108-20260712T143340Z.dump"
  }), {
    startupError: {
      code: "ponder_schema_identity_mismatch",
      message: "Ponder rejected a schema owned by a different app build identity."
    },
    recoveredAt: "2026-07-12T14:34:22Z",
    previousSchema: "agent_indexer_20260516080108",
    currentSchema: "agent_indexer_20260712143422",
    backupFile: "indexer-schema-agent_indexer_20260516080108-20260712T143340Z.dump"
  });
});

test("recovery metadata omits unknown or incomplete startup claims", () => {
  assert.equal(readIndexerRecoveryMetadata({}), undefined);
  assert.equal(readIndexerRecoveryMetadata({
    INDEXER_LAST_STARTUP_ERROR: "generic_failure",
    INDEXER_LAST_RECOVERY_AT: "2026-07-12T14:34:22Z"
  }), undefined);
  assert.equal(readIndexerRecoveryMetadata({
    INDEXER_LAST_STARTUP_ERROR: PONDER_SCHEMA_IDENTITY_MISMATCH,
    INDEXER_LAST_RECOVERY_AT: "not-a-time",
    INDEXER_LAST_RECOVERY_FROM_SCHEMA: "public;drop schema public",
    INDEXER_LAST_RECOVERY_TO_SCHEMA: "agent_indexer_new"
  }), undefined);
});
