import { randomUUID } from "node:crypto";

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const VALID_LEVELS = new Set(Object.keys(LEVEL_ORDER));

/**
 * Minimal pino-style JSON logger.
 *
 *   const logger = createLogger({ name: "http", level: "info" });
 *   logger.info({ requestId }, "request.start");
 *   logger.error({ err }, "blockchain.revert");
 *
 * Each line is one JSON object written to stdout (stderr for error level),
 * carrying: ts, level, name, msg, plus whatever fields the caller attached.
 *
 * `logger.child({ requestId })` returns a new logger that merges those fields
 * into every subsequent record. Used to thread a correlation id through a
 * request's call chain without passing it explicitly everywhere.
 */
export function createLogger({ name = "app", level = "info", base = {}, sink = defaultSink } = {}) {
  const normalizedLevel = VALID_LEVELS.has(level) ? level : "info";
  const threshold = LEVEL_ORDER[normalizedLevel];
  return buildLogger({ name, threshold, base, sink });
}

function buildLogger({ name, threshold, base, sink }) {
  function shouldLog(levelName) {
    return LEVEL_ORDER[levelName] >= threshold;
  }

  function emit(levelName, fieldsOrMessage, message) {
    if (!shouldLog(levelName)) {
      return;
    }
    const record = buildRecord(levelName, name, base, fieldsOrMessage, message);
    sink(levelName, record);
  }

  return {
    debug(fieldsOrMessage, message) {
      emit("debug", fieldsOrMessage, message);
    },
    info(fieldsOrMessage, message) {
      emit("info", fieldsOrMessage, message);
    },
    warn(fieldsOrMessage, message) {
      emit("warn", fieldsOrMessage, message);
    },
    error(fieldsOrMessage, message) {
      emit("error", fieldsOrMessage, message);
    },
    // Compatibility: some upstream callers pass console-style string messages.
    log(fieldsOrMessage, message) {
      emit("info", fieldsOrMessage, message);
    },
    child(extraFields = {}) {
      return buildLogger({ name, threshold, base: { ...base, ...extraFields }, sink });
    }
  };
}

function buildRecord(levelName, name, base, fieldsOrMessage, message) {
  const record = {
    ts: new Date().toISOString(),
    level: levelName,
    name,
    ...base
  };

  if (typeof fieldsOrMessage === "string") {
    record.msg = fieldsOrMessage;
    return record;
  }

  if (fieldsOrMessage && typeof fieldsOrMessage === "object") {
    for (const [key, value] of Object.entries(fieldsOrMessage)) {
      if (key === "err" && value instanceof Error) {
        record.err = serializeError(value);
      } else {
        record[key] = value;
      }
    }
  }

  if (typeof message === "string") {
    record.msg = message;
  }
  return record;
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode,
    details: error.details
  };
}

function defaultSink(levelName, record) {
  const line = `${JSON.stringify(record)}\n`;
  if (levelName === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

/** Return the supplied request id header value, or generate a fresh UUID. */
export function resolveRequestId(request) {
  const header = request?.headers?.["x-request-id"];
  if (typeof header === "string" && header.trim().length > 0 && header.length <= 128) {
    return header.trim();
  }
  return randomUUID();
}
