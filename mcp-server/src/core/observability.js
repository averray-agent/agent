/**
 * Optional Sentry integration seam.
 *
 * Design constraints:
 * - Zero required dependencies. `@sentry/node` is only loaded when
 *   `SENTRY_DSN` is set AND the module resolves at runtime — we dynamically
 *   import so the base install stays dep-free.
 * - Safe fallback. When Sentry isn't available, `captureException` and
 *   `captureMessage` forward to the structured logger so errors still land
 *   somewhere visible. Call sites don't branch on Sentry availability.
 *
 * Operators who want Sentry should:
 *   1. `npm install @sentry/node` in the mcp-server workspace
 *   2. Set SENTRY_DSN (and optionally SENTRY_ENVIRONMENT / SENTRY_RELEASE)
 */

export async function createObservability({ logger, env = process.env, sentryLoader = loadSentry } = {}) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    return logOnly(logger);
  }

  let sentry;
  try {
    sentry = await sentryLoader(dsn, logger, env);
  } catch (error) {
    logger.warn?.(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "observability.sentry_unavailable"
    );
    return logOnly(logger);
  }

  return {
    captureException(error, context = {}) {
      try {
        sentry.captureException(error, { extra: context });
      } catch {
        // Never let telemetry failures break a request.
      }
      logger.error?.({ err: error, ...context }, "observability.captured_exception");
    },
    captureMessage(message, { level = "info", ...context } = {}) {
      try {
        sentry.captureMessage(message, { level, extra: context });
      } catch {
        // fall through to log
      }
      (logger[level] ?? logger.info)?.(context, message);
    },
    flush(timeoutMs = 2_000) {
      return sentry.flush?.(timeoutMs).catch(() => false) ?? Promise.resolve(true);
    },
    isEnabled: true
  };
}

async function loadSentry(dsn, logger, env = process.env) {
  let mod;
  try {
    mod = await import("@sentry/node");
  } catch (error) {
    throw new Error(
      `SENTRY_DSN is set but @sentry/node could not be loaded: ${error?.message ?? "unknown"}. ` +
        "Run `npm install @sentry/node` in mcp-server to enable Sentry."
    );
  }
  mod.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: parseRate(env.SENTRY_TRACES_SAMPLE_RATE, 0)
  });
  logger.info?.(
    { environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production" },
    "observability.sentry_ready"
  );
  return mod;
}

function parseRate(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

function logOnly(logger) {
  return {
    captureException(error, context = {}) {
      logger.error?.({ err: error, ...context }, "observability.captured_exception");
    },
    captureMessage(message, { level = "info", ...context } = {}) {
      (logger[level] ?? logger.info)?.(context, message);
    },
    flush() {
      return Promise.resolve(true);
    },
    isEnabled: false
  };
}
