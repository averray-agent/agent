import { Hono } from "hono";
import { graphql } from "ponder";
import { db } from "ponder:api";
import schema from "ponder:schema";

import { decodeCursor, listTerminalXcmOutcomes, normalizeLimit } from "./xcm-outcomes";
import { cursorForSource, type OutcomeCursorMode } from "./xcm-outcome-cursor";
import { XcmOutcomePublisherService } from "./xcm-outcome-publisher";

const GRAPHQL_BEARER_TOKEN = process.env.GRAPHQL_BEARER_TOKEN?.trim() || undefined;
if (!GRAPHQL_BEARER_TOKEN) {
  // Loud warning rather than silent open route: /graphql exposes the full
  // indexer schema (including the GraphiQL playground) and is reverse-proxied
  // by Caddy on `index.averray.com` with no perimeter auth. Set
  // GRAPHQL_BEARER_TOKEN to gate the endpoint; until then a startup line
  // here records that the route is intentionally public.
  // eslint-disable-next-line no-console
  console.warn(
    "[indexer] WARNING: /graphql is publicly reachable — GRAPHQL_BEARER_TOKEN is unset. Set it in deploy/indexer.env.template (see header comments) to require Bearer auth."
  );
}

const app = new Hono();
const xcmExternalSourceType = process.env.XCM_EXTERNAL_SOURCE_TYPE?.trim() || "feed";
const xcmOutcomePublisher = new XcmOutcomePublisherService({
  enabled: process.env.XCM_OUTCOME_PUBLISHER_ENABLED === undefined
    ? inferPublisherEnabled(xcmExternalSourceType)
    : ["1", "true", "yes", "on"].includes(String(process.env.XCM_OUTCOME_PUBLISHER_ENABLED).trim().toLowerCase()),
  sourceType: xcmExternalSourceType,
  sourceUrl: process.env.XCM_EXTERNAL_SOURCE_URL?.trim(),
  authToken: process.env.XCM_EXTERNAL_SOURCE_AUTH_TOKEN?.trim(),
  apiHost: process.env.XCM_SUBSCAN_API_HOST?.trim(),
  apiKey: process.env.XCM_SUBSCAN_API_KEY?.trim(),
  nativeHubWs: process.env.XCM_NATIVE_HUB_WS?.trim(),
  nativeBifrostWs: process.env.XCM_NATIVE_BIFROST_WS?.trim(),
  nativeStartBlock: parseOptionalNonNegativeInt(process.env.XCM_NATIVE_START_BLOCK),
  nativeConfirmations: parseOptionalNonNegativeInt(process.env.XCM_NATIVE_CONFIRMATIONS),
  pollIntervalMs: parsePositiveInt(process.env.XCM_OUTCOME_PUBLISHER_POLL_MS, 30_000),
  batchSize: parsePositiveInt(process.env.XCM_OUTCOME_PUBLISHER_BATCH_SIZE, 25)
});
xcmOutcomePublisher.start();

app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "agent-platform-indexer",
    endpoints: ["/graphql", "/xcm/outcomes", "/xcm/outcomes/status"]
  })
);

app.get("/xcm/outcomes", async (c) => {
  const limit = normalizeLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));
  const usePublishedFeed = await xcmOutcomePublisher.hasPublishedOutcomes();
  const sourceMode: OutcomeCursorMode = usePublishedFeed ? "external" : "indexed";
  const sourceCursor = cursorForSource(cursor, sourceMode);
  const outcomes = usePublishedFeed
    ? await xcmOutcomePublisher.listPublishedOutcomes({ limit, cursor: sourceCursor })
    : await listTerminalXcmOutcomes({ limit, cursor: sourceCursor });

  return c.json({
    items: outcomes.items,
    nextCursor: outcomes.nextCursor,
    meta: {
      limit,
      terminalStatuses: ["succeeded", "failed", "cancelled"],
      source: usePublishedFeed ? "external_xcm_observer_feed" : "indexer_terminal_status_feed",
      sourceMode,
      cursor: {
        requestedMode: cursor?.mode,
        accepted: !cursor || Boolean(sourceCursor),
        reset: Boolean(cursor && !sourceCursor)
      }
    }
  });
});

app.get("/xcm/outcomes/status", async (c) =>
  c.json(await xcmOutcomePublisher.getStatus())
);

app.use(
  "/graphql",
  async (c, next) => {
    // Optional Bearer gate. When GRAPHQL_BEARER_TOKEN is unset, the route
    // remains publicly reachable for backward compatibility (a startup
    // warning is logged in that case). When set, every request must carry
    // `Authorization: Bearer <token>` — both POST queries and the GET
    // GraphiQL playground are gated through the same middleware.
    if (!GRAPHQL_BEARER_TOKEN) {
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    if (header !== `Bearer ${GRAPHQL_BEARER_TOKEN}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  },
  graphql({ db, schema })
);

export default app;

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function inferPublisherEnabled(sourceType: string) {
  if (sourceType === "subscan_xcm") {
    return Boolean(
      process.env.XCM_SUBSCAN_API_HOST?.trim() &&
      process.env.XCM_SUBSCAN_API_KEY?.trim()
    );
  }
  if (sourceType === "native_papi") {
    return Boolean(
      process.env.XCM_NATIVE_HUB_WS?.trim() &&
      process.env.XCM_NATIVE_BIFROST_WS?.trim()
    );
  }
  return Boolean(process.env.XCM_EXTERNAL_SOURCE_URL?.trim());
}

function parseOptionalNonNegativeInt(raw: string | undefined) {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
