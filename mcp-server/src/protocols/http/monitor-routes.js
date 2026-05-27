/**
 * Hermes Handoff Monitor — HTTP routes (M4).
 *
 * Three endpoints behind the existing admin/operator auth boundary:
 *
 *   GET  /api/monitor/board         — JSON snapshot of every card
 *   GET  /api/monitor/stream        — SSE: board.snapshot + live mutations
 *   POST /api/monitor/debug/spawn   — admin-only; adds a fixture card
 *                                     and emits board.card.added. The
 *                                     acceptance vehicle for "spawn a
 *                                     card via API, see it appear
 *                                     within 500ms."
 *
 * Mirrors the route-split pattern from the P2.3 work. The actual
 * board state lives in `MonitorService` (mcp-server/src/services).
 *
 * M5+ progressively replace the fixture-backed service with real
 * GitHub / Codex / Hermes / deploy data sources; the route layer
 * stays the same.
 */

import { MONITOR_KEEPALIVE_INTERVAL_MS } from "../../services/monitor-service.js";

/**
 * @typedef {import("../../services/monitor-service.js").MonitorService} MonitorService
 */

/**
 * SSE write helpers — mirror event-routes.js conventions so the
 * client `EventSource` parses our stream the same way it parses
 * the existing /events stream.
 */
function respondSse(response) {
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(response._corsHeaders ?? {}),
  };
  if (response._requestId) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(200, headers);
}

function writeSseEvent(response, { id, topic, data }) {
  if (id) response.write(`id: ${id}\n`);
  if (topic) response.write(`event: ${topic}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createMonitorRoutes({
  authMiddleware,
  monitorService,
  respond,
  hasRole,
}) {
  return async function handleMonitorRoute({ request, response, url, pathname }) {
    if (!pathname.startsWith("/api/monitor")) return false;

    // ── GET /api/monitor/board ───────────────────────────────────
    if (request.method === "GET" && pathname === "/api/monitor/board") {
      await authMiddleware(request, url);
      const snapshot = monitorService.getBoardSnapshot();
      respond(response, 200, snapshot, {
        // Short cache so a SWR refetch on focus actually re-reads.
        "cache-control": "private, max-age=2",
      });
      return true;
    }

    // ── GET /api/monitor/stream ──────────────────────────────────
    if (request.method === "GET" && pathname === "/api/monitor/stream") {
      // Bearer query-token allowed because EventSource cannot send
      // Authorization headers natively. Same pattern as /events.
      const auth = await authMiddleware(request, url, { allowQueryToken: true });
      respondSse(response);

      // Keepalive: SSE intermediaries (CDNs, reverse proxies) tend
      // to close idle connections at 30-60s. Send a periodic
      // keepalive so the stream survives.
      const keepaliveTimer = setInterval(() => {
        try {
          monitorService.emitKeepalive();
        } catch {
          // Ignore — the monitor-service.subscribe error path will
          // log the write failure if the response is already dead.
        }
      }, MONITOR_KEEPALIVE_INTERVAL_MS);

      let eventCounter = 0;
      const unsubscribe = monitorService.subscribe((event) => {
        if (response.destroyed || response.writableEnded) {
          // Client gone — clean up.
          clearInterval(keepaliveTimer);
          unsubscribe();
          return;
        }
        writeSseEvent(response, {
          id: `${event.type}-${++eventCounter}-${Date.now()}`,
          topic: event.type,
          data: event,
        });
      });

      // Clean up when the client disconnects.
      const cleanup = () => {
        clearInterval(keepaliveTimer);
        unsubscribe();
        try {
          response.end();
        } catch {
          /* already closed */
        }
      };
      request.on("close", cleanup);
      request.on("aborted", cleanup);
      response.on("close", cleanup);

      // Annotate for /metrics so the operator can see how many SSE
      // clients are connected.
      response._monitorSubscriberWallet = auth.wallet;
      return true;
    }

    // ── POST /api/monitor/debug/spawn ────────────────────────────
    // Admin-only. The M4 acceptance vehicle — adds a card to the
    // in-memory store and the SSE stream broadcasts it. M5+ this
    // gets replaced by real source ingestion (GitHub webhooks,
    // Codex runner heartbeat, etc.) but the contract stays the same.
    if (request.method === "POST" && pathname === "/api/monitor/debug/spawn") {
      const auth = await authMiddleware(request, url);
      if (!hasRole(auth.claims, "admin")) {
        return respond(response, 403, {
          error: "missing_role",
          required: "admin",
          reason: "POST /api/monitor/debug/spawn is admin-only",
        });
      }
      const body = await readJsonBody(request);
      const card = body?.card;
      if (!card || typeof card.id !== "string") {
        return respond(response, 400, {
          error: "invalid_payload",
          reason: "expected { card: { id, lane, type, ... } }",
        });
      }
      monitorService.addCard(card);
      return respond(response, 200, { ok: true, id: card.id });
    }

    return false;
  };
}

/** @param {import("node:http").IncomingMessage} request */
async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    request.on("error", reject);
  });
}
