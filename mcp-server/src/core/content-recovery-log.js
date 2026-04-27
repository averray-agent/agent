import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalizeContent } from "./canonical-content.js";
import { assertContentHashMatches } from "./content-addressed-store.js";
import { ConfigError, ExternalServiceError } from "./errors.js";

export const DEFAULT_CONTENT_RECOVERY_LOG_DIR = ".content-recovery-log";

export class ContentRecoveryLog {
  constructor({ dir = DEFAULT_CONTENT_RECOVERY_LOG_DIR, enabled = true, logger = console } = {}) {
    this.dir = resolve(dir);
    this.enabled = Boolean(enabled);
    this.logger = logger;
  }

  async append(record, { loggedAt = new Date().toISOString() } = {}) {
    if (!this.enabled) {
      return { enabled: false };
    }
    assertContentHashMatches(record);
    const entry = {
      kind: "content.upserted",
      loggedAt,
      hash: record.hash,
      contentType: record.contentType,
      ownerWallet: record.ownerWallet,
      verdict: record.verdict,
      createdAt: record.createdAt,
      publishedAt: record.publishedAt,
      autoPublicAt: record.autoPublicAt,
      payload: record.payload
    };

    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = join(this.dir, `${loggedAt.slice(0, 10)}.jsonl`);
      await appendFile(file, `${canonicalizeContent(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      return { enabled: true, file, hash: record.hash };
    } catch (error) {
      throw new ExternalServiceError(`Content recovery log append failed: ${error?.message ?? "unknown_error"}`);
    }
  }

}

export function createContentRecoveryLog(env = process.env, { logger = console } = {}) {
  const enabled = env.CONTENT_RECOVERY_LOG_ENABLED === undefined
    ? true
    : parseBooleanEnv(env.CONTENT_RECOVERY_LOG_ENABLED);
  const dir = env.CONTENT_RECOVERY_LOG_DIR?.trim() || DEFAULT_CONTENT_RECOVERY_LOG_DIR;
  return new ContentRecoveryLog({ dir, enabled, logger });
}

function parseBooleanEnv(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError("CONTENT_RECOVERY_LOG_ENABLED must be a boolean-like value.");
}
