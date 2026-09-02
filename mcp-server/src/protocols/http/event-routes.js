function respondSse(response) {
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(response._corsHeaders ?? {})
  };
  if (response._requestId) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(200, headers);
}

function writeSseEvent(response, { id, topic, data }) {
  if (id) {
    response.write(`id: ${id}\n`);
  }
  if (topic) {
    response.write(`event: ${topic}\n`);
  }
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createEventRoutes({
  authMiddleware,
  enforceLimit,
  eventBus,
  metrics,
  parseEventFilters,
  parseLimit,
  rateLimitConfig,
}) {
  return async function handleEventRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/events") {
      return false;
    }

    const auth = await authMiddleware(request, url, { allowQueryToken: true });
    await enforceLimit("events", auth.wallet, rateLimitConfig.events);
    respondSse(response);

    const filter = {
      wallet: auth.wallet,
      jobId: url.searchParams.get("jobId") ?? undefined,
      sessionId: url.searchParams.get("sessionId") ?? undefined,
      ...parseEventFilters(url)
    };
    const lastEventId = request.headers?.["last-event-id"]
      ?? url.searchParams.get("lastEventId")
      ?? undefined;
    const replay = eventBus?.replayDurable
      ? await eventBus.replayDurable(filter, lastEventId, { limit: parseLimit(url, 100, 500) })
      : eventBus?.replay?.(filter, lastEventId);

    if (replay?.gap) {
      writeSseEvent(response, {
        id: `gap-${Date.now()}`,
        topic: "gap",
        data: {
          topic: "gap",
          lastDelivered: lastEventId ?? null
        }
      });
    }

    for (const event of replay?.events ?? []) {
      writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
    }

    const heartbeat = setInterval(() => {
      response.write(": ping\n\n");
    }, 15_000);

    const unsubscribe = eventBus?.subscribe?.(filter, (event) => {
      writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
    });

    metrics.gauge("sse_active_connections").inc();
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      metrics.gauge("sse_active_connections").dec();
      response.end();
    });
    return true;
  };
}
