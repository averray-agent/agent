// Hermes Handoff Monitor — route layout.
//
// This file is the import boundary for the monitor's bespoke styles.
// `app/styles/monitor.css` carries the full hand-curated CSS from the
// Claude Design handoff bundle (1999 lines, ~100 hm-* classes). It
// depends on the base --avy-* tokens already shipped in
// `app/styles/tokens.css`, so dropping it in here resolves cleanly.
//
// CSS scope: the styles target only `.hm-*` class names, none of
// which appear elsewhere in the operator app. Next.js still hoists
// imported CSS to the global stylesheet at build time, but the
// scoping is namespace-based (the prefix) rather than module-based.
//
// The (authed) layout already mounts the auth guard + Demo banner +
// AuthRefreshBridge above this; nothing extra to do here.

import "@/styles/monitor.css";

export default function MonitorRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
