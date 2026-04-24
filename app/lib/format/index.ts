/**
 * Small format helpers shared across the operator UI.
 *
 * Ported from frontend/ui-helpers.js — these are light enough to reimplement
 * in TypeScript rather than pulling the legacy module in as a dependency.
 */

export function shortAddress(address: string | undefined | null, chars = 4): string {
  if (!address || typeof address !== "string") return "—";
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

export function formatAmount(value: string | number | undefined, symbol = ""): string {
  if (value === undefined || value === null || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const display = n.toLocaleString("en-US", {
    maximumFractionDigits: n < 1 ? 6 : 2,
    minimumFractionDigits: 0,
  });
  return symbol ? `${display} ${symbol}` : display;
}

export function relativeTime(input: string | number | Date | undefined | null): string {
  if (!input) return "—";
  const when = typeof input === "string" || typeof input === "number" ? new Date(input) : input;
  const ms = Date.now() - when.getTime();
  if (!Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const suffix = ms >= 0 ? "ago" : "from now";
  if (sec < 45) return "just now";
  if (min < 2) return `1 min ${suffix}`;
  if (min < 60) return `${min} min ${suffix}`;
  if (hr < 2) return `1 hr ${suffix}`;
  if (hr < 24) return `${hr} hr ${suffix}`;
  if (day < 2) return `1 day ${suffix}`;
  return `${day} days ${suffix}`;
}

export type StatusTone = "neutral" | "success" | "warn" | "muted" | "accent";

export function sessionStateTone(state: string | undefined): StatusTone {
  switch ((state ?? "").toLowerCase()) {
    case "approved":
    case "settled":
    case "verified":
      return "success";
    case "rejected":
    case "disputed":
    case "slashed":
      return "warn";
    case "pending":
    case "active":
    case "claimed":
    case "submitted":
      return "accent";
    default:
      return "muted";
  }
}
