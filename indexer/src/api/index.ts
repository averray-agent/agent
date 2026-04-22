import { Hono } from "hono";
import { client, graphql } from "ponder";
import { db } from "ponder:api";
import schema from "ponder:schema";

import { decodeCursor, listTerminalXcmOutcomes, normalizeLimit } from "./xcm-outcomes";
import { XcmOutcomePublisherService } from "./xcm-outcome-publisher";

const app = new Hono();
const xcmExternalSourceType = process.env.XCM_EXTERNAL_SOURCE_TYPE?.trim() || "feed";
const xcmOutcomePublisher = await new XcmOutcomePublisherService({
  enabled: process.env.XCM_OUTCOME_PUBLISHER_ENABLED === undefined
    ? inferPublisherEnabled(xcmExternalSourceType)
    : ["1", "true", "yes", "on"].includes(String(process.env.XCM_OUTCOME_PUBLISHER_ENABLED).trim().toLowerCase()),
  sourceType: xcmExternalSourceType,
  sourceUrl: process.env.XCM_EXTERNAL_SOURCE_URL?.trim(),
  authToken: process.env.XCM_EXTERNAL_SOURCE_AUTH_TOKEN?.trim(),
  apiHost: process.env.XCM_SUBSCAN_API_HOST?.trim(),
  apiKey: process.env.XCM_SUBSCAN_API_KEY?.trim(),
  pollIntervalMs: parsePositiveInt(process.env.XCM_OUTCOME_PUBLISHER_POLL_MS, 30_000),
  batchSize: parsePositiveInt(process.env.XCM_OUTCOME_PUBLISHER_BATCH_SIZE, 25)
}).init();
xcmOutcomePublisher.start();

app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "agent-platform-indexer",
    endpoints: ["/graphql", "/sql", "/xcm/outcomes", "/xcm/outcomes/status"]
  })
);

app.get("/xcm/outcomes", async (c) => {
  const limit = normalizeLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));
  const usePublishedFeed = await xcmOutcomePublisher.hasPublishedOutcomes();
  const outcomes = usePublishedFeed
    ? await xcmOutcomePublisher.listPublishedOutcomes({ limit, cursor })
    : await listTerminalXcmOutcomes({ limit, cursor });

  return c.json({
    items: outcomes.items,
    nextCursor: outcomes.nextCursor,
    meta: {
      limit,
      terminalStatuses: ["succeeded", "failed", "cancelled"],
      source: usePublishedFeed ? "external_xcm_observer_feed" : "indexer_terminal_status_feed"
    }
  });
});

app.get("/xcm/outcomes/status", async (c) =>
  c.json(await xcmOutcomePublisher.getStatus())
);

app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

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
  return Boolean(process.env.XCM_EXTERNAL_SOURCE_URL?.trim());
}
