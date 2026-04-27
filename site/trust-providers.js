(function () {
  const ENDPOINT = "https://api.averray.com/status/providers";

  const PROVIDER_LABEL = {
    github: "GitHub issues",
    wikipedia: "Wikipedia maintenance",
    osv: "OSV advisories",
    openData: "Open data",
    standards: "Standards freshness",
    openApi: "OpenAPI quality",
  };

  const PROVIDER_TARGET_UNIT = {
    github: "queries",
    wikipedia: "categories",
    osv: "packages",
    openData: "datasets",
    standards: "specs",
    openApi: "specs",
  };

  const HEALTH_LABEL = {
    healthy: "Healthy",
    dry_run: "Dry run",
    at_capacity: "At capacity",
    error: "Error",
    disabled: "Disabled",
  };

  const MODE_LABEL = {
    live: "Live",
    dry_run: "Dry run",
    disabled: "Disabled",
  };

  const HEALTH_PRIORITY = {
    error: 0,
    at_capacity: 1,
    dry_run: 2,
    healthy: 3,
    disabled: 4,
  };

  const PROVIDER_ORDER = [
    "github",
    "wikipedia",
    "osv",
    "openData",
    "standards",
    "openApi",
  ];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) =>
      ch === "&"
        ? "&amp;"
        : ch === "<"
        ? "&lt;"
        : ch === ">"
        ? "&gt;"
        : ch === '"'
        ? "&quot;"
        : "&#39;"
    );
  }

  function nonNegInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function asString(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }

  function formatRelative(iso) {
    if (!iso) return "never";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (deltaSec < 60) return deltaSec + "s ago";
    const deltaMin = Math.round(deltaSec / 60);
    if (deltaMin < 60) return deltaMin + "m ago";
    const deltaHr = Math.round(deltaMin / 60);
    if (deltaHr < 24) return deltaHr + "h ago";
    return Math.round(deltaHr / 24) + "d ago";
  }

  function buildProvider(key, raw) {
    const lastRunRaw = raw && typeof raw.lastRun === "object" ? raw.lastRun : null;
    const lastRun = lastRunRaw
      ? {
          dryRun: lastRunRaw.dryRun !== false,
          summary: asString(lastRunRaw.summary, ""),
          errorCount: nonNegInt(lastRunRaw.errorCount),
        }
      : null;
    return {
      key: key,
      label: asString(raw && raw.label, PROVIDER_LABEL[key] || key),
      mode: ["live", "dry_run", "disabled"].includes(raw && raw.mode) ? raw.mode : "disabled",
      health: ["healthy", "dry_run", "at_capacity", "error", "disabled"].includes(raw && raw.health) ? raw.health : "disabled",
      running: Boolean(raw && raw.running),
      maxOpenJobs: nonNegInt(raw && raw.maxOpenJobs),
      currentOpenJobs: nonNegInt(raw && raw.currentOpenJobs),
      targetCount: nonNegInt(raw && raw.targetCount),
      lastRunAt: asString(raw && raw.lastRunAt, ""),
      lastRun: lastRun,
    };
  }

  function extractProviders(payload) {
    const root = payload && typeof payload === "object" && payload.providerOperations;
    if (!root || typeof root !== "object") return [];
    const out = [];
    for (const key of PROVIDER_ORDER) {
      const entry = root[key];
      if (!entry || typeof entry !== "object") continue;
      out.push(buildProvider(key, entry));
    }
    out.sort((a, b) => {
      const delta = HEALTH_PRIORITY[a.health] - HEALTH_PRIORITY[b.health];
      if (delta !== 0) return delta;
      return PROVIDER_ORDER.indexOf(a.key) - PROVIDER_ORDER.indexOf(b.key);
    });
    return out;
  }

  function renderProvider(provider) {
    const cap = provider.maxOpenJobs;
    const open = provider.currentOpenJobs;
    const fillPct = cap > 0 ? Math.min(100, Math.round((open / cap) * 100)) : 0;
    const unit = PROVIDER_TARGET_UNIT[provider.key] || "items";
    const lastRunSummary = provider.lastRun && provider.lastRun.summary
      ? provider.lastRun.summary
      : "No runs recorded yet.";
    const errorCount = provider.lastRun ? provider.lastRun.errorCount : 0;
    const lastRunRel = provider.lastRunAt ? "last run " + formatRelative(provider.lastRunAt) : "never";

    return (
      '<article class="site-card provider-row provider-row--' + escapeHtml(provider.health) + '">' +
        '<header class="provider-row-head">' +
          '<h3>' + escapeHtml(provider.label) + '</h3>' +
          '<span class="provider-pill provider-pill--' + escapeHtml(provider.health) + '">' + escapeHtml(HEALTH_LABEL[provider.health]) + '</span>' +
        '</header>' +
        '<p class="provider-row-meta">' +
          '<span class="provider-mode provider-mode--' + escapeHtml(provider.mode) + '">' + escapeHtml(MODE_LABEL[provider.mode]) + '</span>' +
          ' · <strong>' + escapeHtml(String(provider.targetCount)) + '</strong> ' + escapeHtml(unit) +
          ' · open jobs <strong>' + escapeHtml(String(open)) + '</strong> / ' + escapeHtml(String(cap)) +
        '</p>' +
        '<div class="provider-bar"><span style="width:' + fillPct + '%"></span></div>' +
        '<p class="provider-row-summary">' + escapeHtml(lastRunSummary) + '</p>' +
        '<p class="provider-row-foot">' +
          escapeHtml(lastRunRel) +
          (errorCount > 0
            ? ' · <span class="provider-error">' + errorCount + " error" + (errorCount === 1 ? "" : "s") + "</span>"
            : "") +
          (provider.running ? ' · <span class="provider-running">Running</span>' : "") +
        '</p>' +
      '</article>'
    );
  }

  function renderEmpty(message) {
    return (
      '<article class="site-card">' +
        '<p class="label">Live status</p>' +
        '<p class="section-copy">' + escapeHtml(message) + '</p>' +
      '</article>'
    );
  }

  function setMeta(text) {
    const el = document.getElementById("provider-operations-meta");
    if (el) el.textContent = text;
  }

  function setList(html) {
    const el = document.getElementById("provider-operations-list");
    if (el) el.innerHTML = html;
  }

  async function load() {
    try {
      const res = await fetch(ENDPOINT, { credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      const providers = extractProviders(payload);
      if (!providers.length) {
        setMeta("No provider data available.");
        setList(renderEmpty("Provider status is unavailable right now. The endpoint returned no rows."));
        return;
      }
      setMeta(providers.length + " sources · live");
      setList(providers.map(renderProvider).join(""));
    } catch (err) {
      setMeta("Live status unavailable.");
      setList(renderEmpty("We could not reach " + ENDPOINT + " from this browser. The same data is available there directly."));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load, { once: true });
  } else {
    load();
  }
})();
