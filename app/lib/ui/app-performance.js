const START_MARK = "averray:app-observer-mounted";

/**
 * Browser-only, no-network instrumentation for first-paint diagnosis.
 * Durations stay in DevTools; no wallet, route data, or credentials leave the
 * browser. Callers can add milestones for their first live-data resolution.
 */
export function observeAppPerformance(route) {
  if (typeof performance === "undefined") return () => {};

  performance.mark(START_MARK);
  report("hydrated", route, performance.now());

  const navigation = performance.getEntriesByType?.("navigation")?.[0];
  if (navigation) {
    report("navigation", route, navigation.duration, {
      ttfbMs: round(navigation.responseStart),
      responseMs: round(navigation.responseEnd - navigation.responseStart),
      domInteractiveMs: round(navigation.domInteractive),
    });
  }

  for (const entry of performance.getEntriesByType?.("paint") ?? []) {
    report(entry.name, route, entry.startTime);
  }
  reportFirstPaintBreakdown(route);

  if (typeof PerformanceObserver === "undefined") return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      report(entry.name, route, entry.startTime);
    }
  });
  try {
    observer.observe({ type: "paint", buffered: true });
  } catch {
    return () => {};
  }
  return () => observer.disconnect();
}

export function markAppMilestone(name) {
  if (typeof performance === "undefined") return;
  const mark = `averray:${name}`;
  performance.mark(mark);
  report(name, typeof location === "undefined" ? "unknown" : location.pathname, performance.now());
}

function report(event, route, durationMs, detail = {}) {
  // eslint-disable-next-line no-console
  console.info("[app-performance]", {
    event,
    route,
    durationMs: round(durationMs),
    targetMs: 3_000,
    ...detail,
  });
}

function reportFirstPaintBreakdown(route) {
  const paints = performance.getEntriesByType?.("paint") ?? [];
  const firstContentfulPaint = paints.find((entry) => entry.name === "first-contentful-paint");
  if (!firstContentfulPaint) return;

  const resourcesByType = {};
  for (const entry of performance.getEntriesByType?.("resource") ?? []) {
    if (entry.startTime > firstContentfulPaint.startTime) continue;
    const key = entry.initiatorType || "other";
    const current = resourcesByType[key] ?? { count: 0, durationMs: 0 };
    current.count += 1;
    current.durationMs += round(entry.duration) ?? 0;
    resourcesByType[key] = current;
  }

  const longTaskMs = (performance.getEntriesByType?.("longtask") ?? [])
    .filter((entry) => entry.startTime <= firstContentfulPaint.startTime)
    .reduce((total, entry) => total + entry.duration, 0);

  report("first-paint-breakdown", route, firstContentfulPaint.startTime, {
    longTaskMs: round(longTaskMs),
    resourcesByType,
  });
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
}
