"use client";

import { isDemoModeEnabled } from "@/lib/ui/page-mode";

/**
 * Persistent banner mounted in the authed layout. Renders only when
 * `NEXT_PUBLIC_DEMO_MODE=true` at build time. The whole point of the
 * P2.4 close criteria is that an operator using a production
 * deployment must never see fixture data without an unmistakable
 * "this isn't real" marker on every page.
 *
 * In production builds the env var is `false` (or unset) and this
 * component returns `null` — zero visual cost when the platform is
 * telling the truth on its own.
 */
export function DemoModeBanner() {
  if (!isDemoModeEnabled()) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 w-full border-b border-amber-500/40 bg-amber-500/20 px-4 py-2 text-center text-sm font-medium text-amber-100 backdrop-blur"
      data-testid="demo-mode-banner"
    >
      Demo mode — this is not real platform data.
    </div>
  );
}
