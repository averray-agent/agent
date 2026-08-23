/**
 * The public record reader.
 *
 * Fills in averray.com/transparency from GET /transparency. The rules the page
 * states about itself are enforced here, not merely described:
 *
 *   - Money never moves on its own. A figure changes only when a read comes
 *     back different. There is no interpolation, easing, or counting up.
 *   - Only clocks move continuously: the "seconds since read" under each value.
 *   - A reading that cannot be taken says so. `unknown` renders as "no read",
 *     never as zero and never as the last good value silently retained.
 *   - A failed fetch does not blank the page. The last successful reading stays
 *     on screen, visibly ageing, and the band says the reader is stalled.
 */
(function () {
  "use strict";

  var ENDPOINT = "https://api.averray.com/transparency";
  var POLL_MS = 60000;
  var MAX_LOG_LINES = 6;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var previousValues = Object.create(null);
  var firstHeadSeen = null;
  var lastHead = null;
  var stalled = false;

  function resolvePath(root, path) {
    return path.split(".").reduce(function (node, key) {
      return node == null ? undefined : node[key];
    }, root);
  }

  function isUnknown(field) {
    return !field || field.status === "unknown" || field.value === null || field.value === undefined;
  }

  function setText(host, selector, text) {
    var el = host.querySelector(selector);
    if (el) el.textContent = text;
  }

  /** Seconds since a reading was taken. The only thing on the page that ticks. */
  function ageLabel(readAtMs) {
    if (!Number.isFinite(readAtMs)) return "";
    var seconds = Math.max(0, Math.round((Date.now() - readAtMs) / 1000));
    if (seconds < 90) return seconds + "s ago";
    var minutes = Math.round(seconds / 60);
    if (minutes < 90) return minutes + "m ago";
    return Math.round(minutes / 60) + "h ago";
  }

  function flash(host) {
    if (reduceMotion) return;
    var value = host.querySelector(".read__value") || host;
    value.classList.add("stepped");
    window.setTimeout(function () { value.classList.remove("stepped"); }, 1200);
  }

  function renderField(host, field, headValue) {
    var path = host.dataset.read;
    var unknown = isUnknown(field);

    host.classList.toggle("is-unknown", unknown);
    host.classList.toggle("is-stale", !unknown && field.status === "stale");

    // USDC arrives pre-formatted as a string and must be printed verbatim —
    // reformatting it here would be a second opinion about a money figure.
    // Counts and block heights arrive as numbers and get digit grouping.
    var display = unknown
      ? "no read"
      : (typeof field.value === "number" ? field.value.toLocaleString("en-US") : String(field.value));
    setText(host, "[data-value]", display);
    setText(host, "[data-unit]", unknown ? "" : (field.unit && field.unit !== "unknown" ? field.unit : ""));

    // Inline slots (a count inside a sentence) carry no provenance chrome.
    if (host.hasAttribute("data-inline")) {
      if (unknown) setText(host, "[data-value]", "—");
      return;
    }

    setText(host, "[data-source]", unknown ? (field && field.proof ? String(field.proof) : "could not be read") : String(field.source || ""));
    setText(
      host,
      "[data-block]",
      unknown || headValue == null ? "" : "read at block " + Number(headValue).toLocaleString("en-US")
    );
    setText(host, "[data-age]", unknown ? "" : ageLabel(field.readAtMs));

    // Step only on a genuine change of value.
    if (!unknown && previousValues[path] !== undefined && previousValues[path] !== display) {
      flash(host);
    }
    if (!unknown) previousValues[path] = display;
  }

  function renderComposition(payload) {
    var bar = document.querySelector("[data-comp]");
    if (!bar) return;
    var parts = Array.prototype.slice.call(bar.querySelectorAll("[data-comp-bar]"));
    var total = 0;
    var values = parts.map(function (part) {
      var field = resolvePath(payload, "flow.composition24h." + part.dataset.compBar);
      var value = isUnknown(field) ? 0 : Number(field.value) || 0;
      total += value;
      return { part: part, value: value };
    });

    // With nothing settled there is no composition to draw. An empty bar would
    // read as a measurement; hide it and let the counts speak.
    bar.hidden = total <= 0;
    values.forEach(function (entry) {
      entry.part.style.flexGrow = String(entry.value);
      entry.part.hidden = entry.value <= 0;
    });
  }

  function setReaderState(state, label) {
    var badge = document.querySelector("[data-reader-state]");
    if (!badge) return;
    badge.dataset.readerState = state;
    setText(badge, "[data-reader-label]", label);
  }

  function readerMessageLine() {
    var existing = document.querySelector("[data-reader-message]");
    if (existing) return existing;
    var host = document.querySelector(".band__right");
    if (!host) return null;
    var line = document.createElement("p");
    line.className = "band__since";
    line.dataset.readerMessage = "true";
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    host.appendChild(line);
    return line;
  }

  function showReaderLoading() {
    var line = readerMessageLine();
    if (!line) return;
    line.hidden = false;
    line.textContent = "Loading live figures…";
  }

  function clearReaderMessage() {
    var line = readerMessageLine();
    if (!line) return;
    line.replaceChildren();
    line.hidden = true;
  }

  function showReaderFailure() {
    var line = readerMessageLine();
    if (!line) return;
    var link = document.createElement("a");
    link.href = ENDPOINT;
    link.textContent = ENDPOINT;
    line.replaceChildren(
      document.createTextNode("Figures are served live; they could not be loaded just now — query "),
      link,
      document.createTextNode(" directly.")
    );
    line.hidden = false;
  }

  function appendLog(text, dim) {
    var log = document.querySelector("[data-log]");
    if (!log) return;
    var line = document.createElement("div");
    line.className = dim ? "log__line log__dim" : "log__line";
    line.textContent = text;
    if (log.firstChild && log.firstChild.dataset && log.firstChild.dataset.placeholder) {
      log.removeChild(log.firstChild);
    }
    log.insertBefore(line, log.firstChild);
    while (log.children.length > MAX_LOG_LINES) log.removeChild(log.lastChild);
  }

  function clockLabel() {
    return new Date().toTimeString().slice(0, 8);
  }

  function render(payload) {
    var head = resolvePath(payload, "chain.head");
    var headValue = isUnknown(head) ? null : head.value;
    if (headValue != null) {
      if (firstHeadSeen === null) firstHeadSeen = headValue;
      lastHead = headValue;
      var since = document.querySelector("[data-blocks-since]");
      if (since) {
        var delta = headValue - firstHeadSeen;
        since.hidden = delta <= 0;
        since.textContent = delta + (delta === 1 ? " block" : " blocks") + " since you opened this page";
      }
    }

    var changed = 0;
    document.querySelectorAll("[data-read]").forEach(function (host) {
      var path = host.dataset.read;
      var before = previousValues[path];
      renderField(host, resolvePath(payload, path), headValue);
      if (before !== undefined && before !== previousValues[path]) changed += 1;
    });

    renderComposition(payload);
    setReaderState("live", "Reading now");
    clearReaderMessage();

    var blockPart = headValue == null ? "head unavailable" : "#" + Number(headValue).toLocaleString("en-US");
    appendLog(
      clockLabel() + "  " + blockPart + "  read ok  " + (changed > 0 ? changed + (changed === 1 ? " value stepped" : " values stepped") : "all values unchanged"),
      changed === 0
    );
  }

  function tickAges() {
    document.querySelectorAll("[data-read]:not([data-inline])").forEach(function (host) {
      if (host.classList.contains("is-unknown")) return;
      var slot = host.querySelector("[data-age]");
      if (!slot || !slot.dataset.readAt) return;
      slot.textContent = ageLabel(Number(slot.dataset.readAt));
    });
  }

  // Stamp readAt onto the age slot so the per-second tick needs no payload.
  function stampAges(payload) {
    document.querySelectorAll("[data-read]:not([data-inline])").forEach(function (host) {
      var field = resolvePath(payload, host.dataset.read);
      var slot = host.querySelector("[data-age]");
      if (slot && field && Number.isFinite(field.readAtMs)) slot.dataset.readAt = String(field.readAtMs);
    });
  }

  async function readOnce() {
    try {
      var payload = await window.AverrayReaderFetch.readJsonWithRetry(ENDPOINT, { credentials: "omit" });
      stalled = false;
      render(payload);
      stampAges(payload);
    } catch (error) {
      // Keep the last good reading on screen, ageing honestly. Replacing it
      // with zeros or blanks would be a worse lie than a visibly old number.
      showReaderFailure();
      if (!stalled) {
        stalled = true;
        setReaderState("stalled", "Could not read");
        appendLog(clockLabel() + "  read failed  " + (error && error.message ? error.message : "unavailable") + " · showing the last reading, ageing", true);
      }
    }
  }

  var placeholder = document.querySelector("[data-log] .log__line");
  if (placeholder) placeholder.dataset.placeholder = "true";

  showReaderLoading();
  readOnce();
  window.setInterval(readOnce, POLL_MS);
  window.setInterval(tickAges, 1000);
})();
