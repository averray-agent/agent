"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/use-auth";
import { decideAuthGuardAction } from "@/lib/auth/auth-guard-decisions";
import { AUTH_SESSION_PROBE_TIMEOUT_MS } from "@/lib/auth/session-probe.js";

/**
 * P3.7 — Operator-app authed-layout guard.
 *
 * Wraps every page under `app/app/(authed)/` so an unauthenticated
 * visitor never sees the operator shell, the operator topbar, or live
 * cards backed by 401-quenched fetches. The previous layout rendered
 * the shell unconditionally; the resulting empty cards looked like
 * "the platform has no activity" instead of "you are not signed in" —
 * a truth-boundary failure the audit board flagged as P3.7.
 *
 * Hydration race
 * ──────────────
 * The static-export HTML carries no auth state; `useAuth()` starts
 * with `authenticated: false` and only reads localStorage in its
 * bounded post-mount probe. Without a hydration latch, every page paints a
 * "redirecting to sign-in" frame on the first client render, then
 * snaps back to the operator shell once the session is read. The
 * The `checked` flag from useAuth holds the gate closed for that read so
 * neither side flashes — signed-out visitors see an actionable wall before
 * the redirect, and signed-in operators see that wall before the shell.
 *
 * The actual decision lives in `auth-guard-decisions.js` so node:test
 * unit tests can cover the classifier without a React renderer.
 */
export function AuthedGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const decision = decideAuthGuardAction({
    authenticated: auth.authenticated,
    hydrated: auth.checked === true,
    currentPath: pathname ?? undefined,
  });

  useEffect(() => {
    if (decision.action === "redirect" && decision.redirectTo) {
      // `replace` rather than `push` so the unauthed page does not
      // land in browser history — the back button on the sign-in
      // screen returns to wherever the operator came from, not to a
      // ghost authed URL.
      router.replace(decision.redirectTo);
    }
  }, [decision.action, decision.redirectTo, router]);

  if (decision.action === "render") {
    return <>{children}</>;
  }

  // "checking" (pre-hydration) and "redirect" (post-hydration, no
  // session) both render an honest, actionable wall. We intentionally do
  // NOT render any operator-shell affordance here — no topbar, no
  // OperatorRail — because doing so would be the exact misleading
  // authed shell P3.7 forbids.
  return <AuthedGuardPlaceholder reason={decision.action} />;
}

function AuthedGuardPlaceholder({ reason }: { reason: "checking" | "redirect" }) {
  return (
    <div
      data-testid="authed-guard-placeholder"
      data-guard-state={reason}
      data-auth-probe-max-ms={AUTH_SESSION_PROBE_TIMEOUT_MS}
      className="grid min-h-[60vh] place-items-center px-6 py-12"
    >
      <section className="w-full max-w-[480px] rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-7 shadow-[var(--shadow-sm)]">
        <p className="eyebrow">Wallet sign-in</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in to open the operator room.</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]" role="status" aria-live="polite">
          {reason === "checking"
            ? "Checking briefly for an existing SIWE session. This wall is usable immediately; a valid session will upgrade it in the background."
            : "No active SIWE session is available. Redirecting to wallet sign-in."}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a className="inline-flex h-10 items-center rounded-[var(--radius)] bg-[var(--accent)] px-4 text-sm font-semibold text-white" href="/sign-in">
            Sign in with wallet
          </a>
          <a className="inline-flex h-10 items-center rounded-[var(--radius)] border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)]" href="/work">
            Browse paid work
          </a>
        </div>
      </section>
    </div>
  );
}
