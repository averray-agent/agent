import { createHash, createHmac } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalizeContent } from "./canonical-content.js";
import { assertContentHashMatches, buildContentRecord } from "./content-addressed-store.js";
import { ConfigError, ExternalServiceError } from "./errors.js";

export const DEFAULT_CONTENT_RECOVERY_LOG_DIR = ".content-recovery-log";

export class ContentRecoveryLog {
  constructor({ dir = DEFAULT_CONTENT_RECOVERY_LOG_DIR, enabled = true, logger = console, objectStore = undefined } = {}) {
    this.dir = resolve(dir);
    this.enabled = Boolean(enabled);
    this.logger = logger;
    this.objectStore = objectStore;
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
    const line = `${canonicalizeContent(entry)}\n`;

    try {
      const objectWrite = await this.objectStore?.putEntry?.(entry, line);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = join(this.dir, `${loggedAt.slice(0, 10)}.jsonl`);
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      return {
        enabled: true,
        file,
        hash: record.hash,
        objectKey: objectWrite?.key
      };
    } catch (error) {
      throw new ExternalServiceError(`Content recovery log append failed: ${error?.message ?? "unknown_error"}`);
    }
  }

}

export class S3ContentRecoveryObjectStore {
  constructor({
    endpoint,
    bucket,
    region = "auto",
    accessKeyId,
    secretAccessKey,
    prefix = "content-recovery-log",
    fetchImpl = globalThis.fetch
  } = {}) {
    if (!endpoint) throw new ConfigError("CONTENT_RECOVERY_OBJECT_ENDPOINT is required when object recovery is enabled.");
    if (!bucket) throw new ConfigError("CONTENT_RECOVERY_OBJECT_BUCKET is required when object recovery is enabled.");
    if (!accessKeyId) throw new ConfigError("CONTENT_RECOVERY_OBJECT_ACCESS_KEY_ID is required when object recovery is enabled.");
    if (!secretAccessKey) throw new ConfigError("CONTENT_RECOVERY_OBJECT_SECRET_ACCESS_KEY is required when object recovery is enabled.");
    if (typeof fetchImpl !== "function") throw new ConfigError("Object recovery requires fetch support.");
    this.endpoint = String(endpoint).replace(/\/+$/u, "");
    this.bucket = String(bucket).trim();
    this.region = String(region || "auto").trim();
    this.accessKeyId = String(accessKeyId).trim();
    this.secretAccessKey = String(secretAccessKey);
    this.prefix = String(prefix || "").replace(/^\/+|\/+$/gu, "");
    this.fetchImpl = fetchImpl;
  }

  async putEntry(entry, body) {
    const key = this.objectKey(entry);
    const url = new URL(`${this.endpoint}/${encodePathSegment(this.bucket)}/${encodeObjectKey(key)}`);
    const payloadHash = sha256Hex(body);
    const now = new Date(entry.loggedAt);
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const headers = {
      "content-type": "application/jsonl; charset=utf-8",
      "if-none-match": "*",
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    headers.authorization = signS3Put({
      method: "PUT",
      url,
      headers,
      payloadHash,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      dateStamp,
      amzDate
    });

    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      body
    });
    if (!response?.ok) {
      const status = response?.status ?? "unknown";
      const detail = typeof response?.text === "function" ? await response.text().catch(() => "") : "";
      throw new ExternalServiceError(`Object recovery write failed with status ${status}${detail ? `: ${detail}` : ""}`);
    }
    return { key };
  }

  objectKey(entry) {
    const day = String(entry?.loggedAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
      throw new ConfigError("content recovery object entry requires ISO loggedAt.");
    }
    const loggedAt = String(entry.loggedAt).replace(/[^0-9A-Za-z._-]/gu, "-");
    const hash = String(entry.hash ?? "").replace(/^0x/u, "");
    return [this.prefix, day, `${loggedAt}-${hash}.jsonl`].filter(Boolean).join("/");
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
    : parseBooleanEnv(env.CONTENT_RECOVERY_LOG_ENABLED, "CONTENT_RECOVERY_LOG_ENABLED");
  const dir = env.CONTENT_RECOVERY_LOG_DIR?.trim() || DEFAULT_CONTENT_RECOVERY_LOG_DIR;
  const objectStore = parseBooleanEnv(env.CONTENT_RECOVERY_OBJECT_ENABLED ?? "0", "CONTENT_RECOVERY_OBJECT_ENABLED")
    ? createContentRecoveryObjectStore(env)
    : undefined;
  return new ContentRecoveryLog({ dir, enabled, logger, objectStore });
}

function parseBooleanEnv(value, label = "boolean env") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${label} must be a boolean-like value.`);
}

export function createContentRecoveryObjectStore(env = process.env) {
  return new S3ContentRecoveryObjectStore({
    endpoint: env.CONTENT_RECOVERY_OBJECT_ENDPOINT?.trim(),
    bucket: env.CONTENT_RECOVERY_OBJECT_BUCKET?.trim(),
    region: env.CONTENT_RECOVERY_OBJECT_REGION?.trim() || "auto",
    accessKeyId: env.CONTENT_RECOVERY_OBJECT_ACCESS_KEY_ID?.trim(),
    secretAccessKey: env.CONTENT_RECOVERY_OBJECT_SECRET_ACCESS_KEY,
    prefix: env.CONTENT_RECOVERY_OBJECT_PREFIX?.trim() || "content-recovery-log"
  });
}

function signS3Put({ method, url, headers, payloadHash, region, accessKeyId, secretAccessKey, dateStamp, amzDate }) {
  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name)] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${secretAccessKey}`, dateStamp),
        region
      ),
      "s3"
    ),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/%2F/giu, "/");
}

function encodeObjectKey(value) {
  return String(value)
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}
