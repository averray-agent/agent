"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/use-auth";
import { decideAuthGuardAction } from "@/lib/auth/auth-guard-decisions";

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
 * post-mount effect. Without a hydration latch, every page paints a
 * "redirecting to sign-in" frame on the first client render, then
 * snaps back to the operator shell once the session is read. The
 * `hydrated` flag below holds the gate closed for that one render so
 * neither side flashes — signed-out visitors see only the neutral
 * placeholder before the redirect, and signed-in operators see the
 * placeholder before the shell.
 *
 * The actual decision lives in `auth-guard-decisions.js` so node:test
 * unit tests can cover the classifier without a React renderer.
 */
export function AuthedGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // `hydrated` flips to true on the first post-mount effect. Until
  // then, `useAuth()` still returns its static initial value and
  // cannot be trusted as a signed-in/out signal.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const decision = decideAuthGuardAction({
    authenticated: auth.authenticated,
    hydrated,
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
  // session) both render the neutral placeholder. We intentionally do
  // NOT render any operator-shell affordance here — no topbar, no
  // OperatorRail — because doing so would be the exact misleading
  // authed shell P3.7 forbids.
  return <AuthedGuardPlaceholder reason={decision.action} />;
}

function AuthedGuardPlaceholder({ reason }: { reason: "checking" | "redirect" }) {
  const message = reason === "redirect"
    ? "Sign-in required. Redirecting…"
    : "Checking sign-in…";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="authed-guard-placeholder"
      data-guard-state={reason}
      className="grid min-h-[60vh] place-items-center px-6 py-12 text-sm text-[var(--avy-muted)]"
    >
      {message}
    </div>
  );
}
