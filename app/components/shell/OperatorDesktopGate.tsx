"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isDesktopOnlyOperatorPath } from "@/lib/ui/mobile-operator.js";

/**
 * Routes without ratified mobile layouts remain desktop-only below 768px.
 * Responsive operational routes pass through this route-scoped gate.
 */
export function OperatorDesktopGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (!isDesktopOnlyOperatorPath(pathname)) return children;

  return (
    <>
      <section
        className="fixed inset-0 z-[100] grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12 md:hidden"
        data-testid="operator-desktop-gate"
      >
        <div className="w-full max-w-[480px] rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow-sm)]">
          <p className="eyebrow">Operator control room</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            The operator control room is built for desktop.
          </h1>
          <div className="mt-6 flex flex-col items-start gap-3">
            <Link
              className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-4 text-sm font-semibold text-white"
              href="/work"
            >
              Find paid work
            </Link>
            <p className="text-sm text-[var(--muted)]">Open on desktop to continue.</p>
          </div>
        </div>
      </section>
      <div className="hidden md:contents">{children}</div>
    </>
  );
}
