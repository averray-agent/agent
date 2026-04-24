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
export const useStrategies = () => useApi("/strategies");
export const useHealth = () => useApi("/health");
export const useOnboarding = () => useApi("/onboarding");
export const useVerifierHandlers = () => useApi("/verifier/handlers");
export const useSessionStateMachine = () => useApi("/session/state-machine");
