"use client";

import { cn } from "@/lib/utils/cn";

/**
 * "Where is this page reading from?" indicator.
 *
 * Every operator page mixes several SWR responses, and some endpoints
 * can be locked behind wallet auth or unavailable while the public
 * surfaces still render. This pill makes that distinction explicit in
 * the topbar, so an operator scanning the dashboard knows whether to
 * trust the numbers in front of them.
 *
 * Four states only — keep it tight:
 *   - `live`     · everything resolved, no errors      → green
 *   - `loading`  · still waiting on the first response → blue, pulsing
 *   - `partial`  · signed-in but some surfaces 401/403 → amber "Partial view"
 *   - `fallback` · request errored or returned nothing → amber
 *
 * "Error" is not a separate state because operators mainly need to
 * know that the current panel is not backed by a successful response.
 * `partial` exists because a role-less wallet session 403s on the
 * admin surfaces while the public feeds stay live — the old behavior
 * rendered that as a green "Live API", which fabricated an all-quiet
 * room (the overview's zeros looked authoritative).
 */
export type FreshnessState = "live" | "loading" | "partial" | "fallback";

const STATE_CLS: Record<
  FreshnessState,
  { dot: string; bg: string; text: string }
> = {
  live: {
    dot: "bg-[var(--avy-accent)]",
    bg: "bg-[var(--avy-accent-soft)]",
    text: "text-[var(--avy-accent)]",
  },
  loading: {
    dot: "bg-[#254e9a] [animation:pulse_1.6s_ease-in-out_infinite]",
    bg: "bg-[#e6ecf7]",
    text: "text-[#254e9a]",
  },
  partial: {
    dot: "bg-[var(--avy-warn)]",
    bg: "bg-[var(--avy-warn-soft)]",
    text: "text-[var(--avy-warn)]",
  },
  fallback: {
    dot: "bg-[var(--avy-warn)]",
    bg: "bg-[var(--avy-warn-soft)]",
    text: "text-[var(--avy-warn)]",
  },
};

const STATE_LABEL: Record<FreshnessState, string> = {
  live: "Live API",
  loading: "Loading",
  partial: "Partial view",
  fallback: "Unavailable",
};

const STATE_TITLE: Record<FreshnessState, string> = {
  live: "Live data from the operator API.",
  loading: "Still waiting on the first API response.",
  partial:
    "Some surfaces on this page are locked for this session (missing role or capability). Everything else is live.",
  fallback:
    "API errored, is locked behind auth, or has not emitted this surface yet.",
};

export function DataFreshnessPill({
  state,
  meta,
  className,
}: {
  state: FreshnessState;
  /** Optional override for the hover title — defaults are usually enough. */
  meta?: string;
  className?: string;
}) {
  const s = STATE_CLS[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        s.bg,
        s.text,
        className
      )}
      style={{ letterSpacing: "0.1em" }}
      title={meta ?? STATE_TITLE[state]}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {STATE_LABEL[state]}
    </span>
  );
}

/**
 * Derive a single freshness state from one or more SWR-style requests.
 *
 *   - if any request errored with a non-auth status → `fallback`
 *   - else if any request errored with 401/403      → `partial`
 *   - else if all requests are still loading and have no data → `loading`
 *   - else → `live`
 *
 * 401/403 does not mean `fallback` (the page still renders live public
 * data), but it must not read as fully `live` either: every caller sits
 * inside the authed layout, whose sign-in guard bounces 401s, so a
 * persistent auth error here means "signed in, but this wallet lacks
 * the role/capability for some surfaces" — the pill says so.
 */
export function freshnessFromRequests(
  ...requests: { data?: unknown; error?: unknown; isLoading?: boolean }[]
): FreshnessState {
  if (requests.length === 0) return "fallback";
  const realError = requests.some((r) => isRealError(r.error));
  if (realError) return "fallback";
  if (requests.some((r) => isAuthError(r.error))) return "partial";
  if (requests.every((r) => !r.data && r.isLoading)) return "loading";
  return "live";
}

function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function isRealError(err: unknown): boolean {
  if (!err) return false;
  // ApiError surfaces an HTTP status; treat 401/403 as expected
  // unauth-mode behavior rather than a freshness fault.
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && (status === 401 || status === 403)) {
    return false;
  }
  return true;
}
