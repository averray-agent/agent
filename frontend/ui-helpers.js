export const formatAmount = (value) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-";
};

// ---------------------------------------------------------------------------
// HTML escaping primitives.
//
// `escapeHtml(value)` coerces arbitrary values to a string and escapes the
// five HTML-significant characters. Nullish values become empty strings so
// call sites don't need to pre-guard with `?? ""`.
//
// `html\`...\`` is a tagged template literal that auto-escapes every
// interpolated expression, except values wrapped with `rawHtml(string)` or
// already returned by a nested `html\`...\`` call (via the SafeHtml marker).
// This prevents XSS at the render boundary while allowing nested composition
// like `html\`<ul>${items.map((i) => html\`<li>${i.name}</li>\`).join("")}</ul>\``.
// ---------------------------------------------------------------------------

const SAFE_HTML = Symbol.for("averray.safeHtml");

const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (isSafeHtml(value)) {
    return value.value;
  }
  return String(value).replace(/[&<>"']/gu, (char) => HTML_ESCAPE_MAP[char]);
}

export function rawHtml(value) {
  return { [SAFE_HTML]: true, value: String(value ?? "") };
}

export function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      out += Array.isArray(v) ? v.map(escapeHtml).join("") : escapeHtml(v);
    }
  }
  return rawHtml(out);
}

export function renderHtml(target, safeOrString) {
  if (!target) return;
  target.innerHTML = isSafeHtml(safeOrString) ? safeOrString.value : escapeHtml(safeOrString);
}

function isSafeHtml(value) {
  return Boolean(value && typeof value === "object" && value[SAFE_HTML] === true);
}

export const setText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

export const setFeedback = (id, value, tone = "neutral") => {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.dataset.tone = tone;
};

export const setOverallStatus = (label, className) => {
  const pill = document.getElementById("system-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

export const setActionStatus = (label, className) => {
  const pill = document.getElementById("action-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

const buttonLabels = new WeakMap();
const toastTimeouts = new WeakMap();

export const setButtonBusy = (button, busy, busyLabel = "Working...") => {
  if (!button) return;

  if (!buttonLabels.has(button)) {
    buttonLabels.set(button, button.textContent);
  }

  button.disabled = busy;
  button.dataset.busy = busy ? "true" : "false";
  button.textContent = busy ? busyLabel : buttonLabels.get(button);
};

// Debug logging is gated behind either `localStorage.setItem("averray:debug", "1")`
// or `window.__AVERRAY_DEBUG__ = true` so noise is suppressed for end users while
// still leaving an easy toggle for support/debugging.
function debugEnabled() {
  try {
    if (typeof window !== "undefined" && window.__AVERRAY_DEBUG__) {
      return true;
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem("averray:debug")) {
      return true;
    }
  } catch {
    // localStorage may throw in sandboxed iframes — treat as "not enabled".
  }
  return false;
}

export const debug = {
  log: (...args) => {
    if (debugEnabled()) console.log(...args); // eslint-disable-line no-console
  },
  warn: (...args) => {
    if (debugEnabled()) console.warn(...args); // eslint-disable-line no-console
  },
  error: (...args) => {
    if (debugEnabled()) console.error(...args); // eslint-disable-line no-console
  }
};

export const showToast = (message, tone = "neutral") => {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.textContent = message;
  stack.appendChild(toast);

  requestAnimationFrame(() => {
    toast.dataset.visible = "true";
  });

  const timeout = setTimeout(() => {
    toast.dataset.visible = "false";
    setTimeout(() => {
      toast.remove();
      toastTimeouts.delete(toast);
    }, 220);
  }, 3400);

  toastTimeouts.set(toast, timeout);
};
