import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalizeContent } from "./canonical-content.js";
import { assertContentHashMatches, buildContentRecord } from "./content-addressed-store.js";
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

export async function replayContentRecoveryLog({
  dir = DEFAULT_CONTENT_RECOVERY_LOG_DIR,
  stateStore,
  apply = false,
  logger = console
} = {}) {
  if (!stateStore || typeof stateStore.getContent !== "function" || typeof stateStore.upsertContent !== "function") {
    throw new ConfigError("replayContentRecoveryLog requires a stateStore with getContent/upsertContent methods.");
  }
  const root = resolve(dir);
  const summary = {
    dryRun: !apply,
    directory: root,
    filesRead: 0,
    recordsSeen: 0,
    restored: 0,
    wouldRestore: 0,
    skipped: 0,
    invalid: 0,
    errors: []
  };

  let files;
  try {
    files = (await readdir(root))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return summary;
    }
    throw new ExternalServiceError(`Content recovery log read failed: ${error?.message ?? "unknown_error"}`);
  }

  for (const name of files) {
    const file = join(root, name);
    summary.filesRead += 1;
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      summary.recordsSeen += 1;
      const location = `${name}:${index + 1}`;
      try {
        const record = recordFromRecoveryLine(line);
        const existing = await stateStore.getContent(record.hash);
        if (existing && canonicalizeContent(existing) === canonicalizeContent(record)) {
          summary.skipped += 1;
          continue;
        }
        if (existing && contentVersionTime(existing) > contentVersionTime(record)) {
          summary.skipped += 1;
          continue;
        }
        if (apply) {
          await stateStore.upsertContent(record);
          summary.restored += 1;
        } else {
          summary.wouldRestore += 1;
        }
      } catch (error) {
        summary.invalid += 1;
        const message = error?.message ?? String(error ?? "unknown_error");
        logger.warn?.({ location, err: error instanceof Error ? error : new Error(message) }, "content_recovery.invalid_record");
        summary.errors.push({ location, message });
      }
    }
  }

  return summary;
}

export function recordFromRecoveryLine(line) {
  const entry = JSON.parse(line);
  if (entry?.kind !== "content.upserted") {
    throw new ConfigError("Unsupported content recovery log entry kind.");
  }
  const record = buildContentRecord({
    payload: entry.payload,
    contentType: entry.contentType,
    ownerWallet: entry.ownerWallet,
    verdict: entry.verdict,
    createdAt: entry.createdAt,
    publishedAt: entry.publishedAt,
    autoPublicAt: entry.autoPublicAt
  });
  assertContentHashMatches({ ...record, hash: entry.hash });
  return { ...record, hash: String(entry.hash).toLowerCase() };
}

function contentVersionTime(record) {
  return Date.parse(record?.publishedAt ?? record?.createdAt ?? "") || 0;
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
