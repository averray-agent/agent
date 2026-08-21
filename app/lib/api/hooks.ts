"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { swrFetcher, ApiError } from "./client";
import { shouldRetryApiError } from "./retry-policy.js";

/**
 * Generic hook for public or authed GET endpoints.
 *
 * Auth-locked responses do NOT auto-retry — a 401 has no session and a 403
 * has no capability, and neither becomes true by asking again. The sign-in
 * guard in the authed layout watches for ApiError status 401 and bounces to
 * /sign-in; a 403 leaves the surface rendered as locked (see feed-presence).
 * See ./retry-policy.js for why retrying these is not merely wasteful.
 */
export function useApi<T = unknown>(
  path: string | null,
  config?: SWRConfiguration<T, ApiError>
) {
  return useSWR<T, ApiError>(path, swrFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: shouldRetryApiError,
    ...config,
  });
}

// Typed convenience hooks — return shapes are `unknown` for now since the
// backend doesn't yet emit full schemas. Claude Design's handoff and later
// passes can narrow these as the UI settles.
export const useAccount = () => useApi("/account");

/**
 * Resolved auth session — the signed-in wallet's effective roles +
 * capabilities + the platform's capability matrix from PR #159. Used
 * by the operator app to gate buttons before the user clicks (so a
 * viewer without `jobs:lifecycle` sees disabled Pause/Archive/Reopen
 * with a hint instead of clicking and getting a 403).
 *
 * 401s don't auto-retry (the `useApi` guard already handles that);
 * consumers treat undefined data as "unauthenticated" and render
 * gates as disabled.
 */
export const useAuthSession = () => useApi("/auth/session");
export const useBorrowCapacity = (asset?: string) =>
  useApi(asset ? `/account/borrow-capacity?asset=${encodeURIComponent(asset)}` : "/account/borrow-capacity");
export const useStrategyPositions = () => useApi("/account/strategies");
export const useTreasurySummary = () =>
  useApi("/admin/treasury/summary", { refreshInterval: 30_000 });
export const useJobs = () => useApi("/jobs");
export const useHumanWorkJobs = () =>
  useApi("/jobs?state=claimable&limit=100", { refreshInterval: 30_000 });
export const useRecommendations = () => useApi("/jobs/recommendations");
export const useJobDefinition = (id: string | null) =>
  useApi(id ? `/jobs/definition?jobId=${encodeURIComponent(id)}` : null);
export const useJobPreflight = (id: string | null) =>
  useApi(id ? `/jobs/preflight?jobId=${encodeURIComponent(id)}` : null);
export const useJobEligibility = (id: string | null) =>
  useApi(id ? `/jobs/explain-eligibility?jobId=${encodeURIComponent(id)}` : null);
export const useJobNetReward = (id: string | null) =>
  useApi<number>(id ? `/jobs/estimate-reward?jobId=${encodeURIComponent(id)}` : null);
export const useSessions = () => useApi("/sessions");
export const useAdminSessions = () =>
  useApi("/admin/sessions?limit=100", { refreshInterval: 15_000 });
// The public directory excludes hosted canary identities. The authenticated
// operator roster opts them back in so regression workers remain observable.
export const useAgents = () => useApi("/agents?includeSynthetic=true");
export const useAgent = (wallet: string | null) =>
  useApi(wallet ? `/agents/${encodeURIComponent(wallet)}` : null);
export const useBadges = () => useApi("/badges");
export const useBadge = (sessionId: string | null) =>
  useApi(sessionId ? `/badges/${encodeURIComponent(sessionId)}` : null);
export const useReceiptDetail = (sessionId: string | null, kind: "run" | "badge" | null) =>
  useApi(
    sessionId
      ? `/badges/${encodeURIComponent(sessionId)}${kind === "run" ? "/run" : ""}`
      : null
  );
export const useAlerts = () => useApi("/alerts");
export const useAudit = () => useApi("/audit");
export const usePolicies = () => useApi("/policies");
export const usePolicy = (tag: string | null) =>
  useApi(tag ? `/policies/${encodeURIComponent(tag)}` : null);
export const useDisputes = () => useApi("/disputes");
export const useDispute = (id: string | null) =>
  useApi(id ? `/disputes/${encodeURIComponent(id)}` : null);
export const useSession = (sessionId: string | null) =>
  useApi(sessionId ? `/session?sessionId=${encodeURIComponent(sessionId)}` : null);
export const useSessionTimeline = (sessionId: string | null) =>
  useApi(sessionId ? `/session/timeline?sessionId=${encodeURIComponent(sessionId)}` : null);
export const useVerifierResult = (sessionId: string | null) =>
  useApi(sessionId ? `/verifier/result?sessionId=${encodeURIComponent(sessionId)}` : null);
export const useStrategies = () => useApi("/strategies");
export const useHealth = () => useApi("/health");
/**
 * Operator-app provider operations status. Authed via `/admin/status`,
 * which carries the full `lastRun.errors[]` / `lastRun.skipped[]` arrays.
 * Polls every 30s — the upstream schedulers tick on minute-ish cadences,
 * so 30s gives an "alive" feel without thrashing the SWR cache.
 *
 * The public /trust page uses the sanitized `/status/providers` route
 * (no auth, empty errors/skipped) — that surface is rendered by a
 * vanilla JS hydrator, not this hook.
 */
export const useProviderOperations = () =>
  useApi("/admin/status", { refreshInterval: 30_000 });
export const usePublicProviderOperations = () =>
  useApi("/status/providers", { refreshInterval: 30_000 });
/**
 * Operator-side full job listing including paused, archived, and stale
 * rows so the operator app can show lifecycle controls. The public
 * `/jobs` feed filters those out by default.
 */
export const useAdminJobs = () =>
  useApi("/admin/jobs", { refreshInterval: 15_000 });

/**
 * Stitched job timeline (PR #149) — claim state + sessions +
 * verification + child-run lineage + recurring derivatives +
 * event-bus events for one job. Powers the JobTimelinePanel under
 * /runs/detail. Skips the fetch when no jobId is selected so the
 * panel doesn't 400 on first paint.
 */
export type JobTimelineFilters = {
  topics?: string[];
  sources?: string[];
  phases?: string[];
  severities?: string[];
  correlationId?: string | null;
  wallet?: string | null;
};

export const useJobTimeline = (jobId: string | null, filters: JobTimelineFilters = {}) =>
  useApi(
    jobId
      ? `/admin/jobs/timeline?${jobTimelineParams(jobId, filters)}`
      : null,
    { refreshInterval: 15_000 }
  );

function jobTimelineParams(jobId: string, filters: JobTimelineFilters): string {
  const params = new URLSearchParams({
    jobId,
    limit: "100",
  });
  appendCsvParam(params, "topics", filters.topics);
  appendCsvParam(params, "sources", filters.sources);
  appendCsvParam(params, "phases", filters.phases);
  appendCsvParam(params, "severities", filters.severities);
  if (filters.correlationId) {
    params.set("correlationId", filters.correlationId);
  }
  if (filters.wallet) {
    params.set("eventWallet", filters.wallet);
  }
  return params.toString();
}

function appendCsvParam(params: URLSearchParams, key: string, values: string[] | undefined) {
  const clean = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (clean.length > 0) {
    params.set(key, clean.join(","));
  }
}
export const useOnboarding = () => useApi("/onboarding");
export const useVerifierHandlers = () => useApi("/verifier/handlers");
export const useSessionStateMachine = () => useApi("/session/state-machine");

/**
 * Operator-issued capability grants (roadmap §6). Lists every grant
 * — active and revoked — newest-first. Polls every 15s so a
 * just-issued grant lands in the panel without a manual refresh.
 */
export const useCapabilityGrants = () =>
  useApi("/admin/capability-grants?limit=200", { refreshInterval: 15_000 });

/**
 * Public poster-door facts (mode, live economics, cancellation promise) —
 * the machine surface from the poster-door packet. The lens renders these
 * values verbatim; it never restates economics from constants.
 */
export const usePosterOnboarding = () => useApi("/poster/onboarding");

/**
 * External catalog rows (the poster lens filters to the signed-in wallet
 * client-side; the recorded on-chain poster on each row is the truth).
 * Polls every 15s like the other list surfaces.
 */
export const useExternalJobs = () =>
  useApi("/jobs?source=external&limit=100", { refreshInterval: 15_000 });

/** Poster-owned draft lookup; `null` id skips the fetch. */
export const useExternalDraft = (draftId: string | null) =>
  useApi(draftId ? `/jobs/draft/${encodeURIComponent(draftId)}` : null);
