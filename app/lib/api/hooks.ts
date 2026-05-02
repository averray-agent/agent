"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { swrFetcher, ApiError } from "./client";

/**
 * Generic hook for public or authed GET endpoints.
 *
 * 401 responses do NOT auto-retry; the sign-in guard in the authed layout
 * watches for ApiError status 401 and bounces to /sign-in.
 */
export function useApi<T = unknown>(
  path: string | null,
  config?: SWRConfiguration<T, ApiError>
) {
  return useSWR<T, ApiError>(path, swrFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: (err) => err.status !== 401,
    ...config,
  });
}

// Typed convenience hooks — return shapes are `unknown` for now since the
// backend doesn't yet emit full schemas. Claude Design's handoff and later
// passes can narrow these as the UI settles.
export const useAccount = () => useApi("/account");
export const useBorrowCapacity = (asset?: string) =>
  useApi(asset ? `/account/borrow-capacity?asset=${encodeURIComponent(asset)}` : "/account/borrow-capacity");
export const useStrategyPositions = () => useApi("/account/strategies");
export const useJobs = () => useApi("/jobs");
export const useRecommendations = () => useApi("/jobs/recommendations");
export const useJobDefinition = (id: string | null) =>
  useApi(id ? `/jobs/definition?jobId=${encodeURIComponent(id)}` : null);
export const useSessions = () => useApi("/sessions");
export const useAgents = () => useApi("/agents");
export const useAgent = (wallet: string | null) =>
  useApi(wallet ? `/agents/${encodeURIComponent(wallet)}` : null);
export const useBadges = () => useApi("/badges");
export const useBadge = (sessionId: string | null) =>
  useApi(sessionId ? `/badges/${encodeURIComponent(sessionId)}` : null);
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
export const useOnboarding = () => useApi("/onboarding");
export const useVerifierHandlers = () => useApi("/verifier/handlers");
export const useSessionStateMachine = () => useApi("/session/state-machine");
