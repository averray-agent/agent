"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Coins,
  FileCheck2,
  Gauge,
  History,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/lib/auth/use-auth";
import { signOut } from "@/lib/auth/siwe";
import { shortAddress } from "@/lib/format";
import { Button } from "@/components/ui/button";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  count?: number | string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Mirrors the IA from the Claude Design Overview: three groups, count chips.
// Counts are seeded with the handoff fixture values so the rail reads
// correctly out of the box; replace with live state when each surface
// gets its data hook (e.g. counts.runs = useSessions().filter(s => s.open).length).
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Room",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/runs", label: "Runs", icon: Gauge, count: 14 },
      { href: "/receipts", label: "Receipts", icon: ScrollText, count: "2,134" },
      { href: "/agents", label: "Agents", icon: Users, count: 8 },
    ],
  },
  {
    label: "Capital",
    items: [
      { href: "/treasury", label: "Treasury", icon: Coins },
      { href: "/sessions", label: "Sessions", icon: History },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/policies", label: "Policies", icon: ShieldCheck, count: 22 },
      { href: "/disputes", label: "Disputes", icon: AlertTriangle, count: 2 },
      { href: "/audit-log", label: "Audit log", icon: FileCheck2 },
    ],
  },
];

export function OperatorRail() {
  const pathname = usePathname();
  const auth = useAuth();

  return (
    <aside className="sticky top-6 flex h-[calc(100vh-3rem)] w-[17rem] shrink-0 flex-col gap-5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
      <header className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] bg-[var(--ink)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
          A
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <strong className="font-[family-name:var(--font-display)] text-base">
            Averray
          </strong>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">
            Control room
          </span>
        </div>
      </header>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto pr-1">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname?.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group flex items-center gap-2.5 rounded-[var(--radius-sm)] border border-transparent px-2.5 py-1.5 text-sm transition-all",
                    active
                      ? "border-[var(--line)] bg-[var(--accent-soft)] text-[var(--accent-hover)]"
                      : "text-[var(--ink)] hover:bg-[var(--paper)]"
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-[var(--accent-hover)]" : "text-[var(--muted)]"
                    )}
                  />
                  <span className="flex-1 font-[family-name:var(--font-display)] font-semibold tracking-tight">
                    {item.label}
                  </span>
                  {item.count !== undefined ? (
                    <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]">
                      {item.count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <footer className="flex flex-col gap-2 border-t border-[var(--line)] pt-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
          {auth.authenticated ? "Signed in" : "Operator state"}
        </p>
        {auth.authenticated ? (
          <>
            <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--ink)]">
              {shortAddress(auth.wallet)}
            </p>
            <p className="text-[11px] text-[var(--muted)]">
              {auth.roles.length ? auth.roles.join(" · ") : "worker"}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-1"
              onClick={() => {
                signOut().catch(() => undefined);
              }}
            >
              Sign out
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-[var(--ink)]">Waiting for wallet</p>
            <p className="text-[11px] text-[var(--muted)]">
              Overview is ready. Sign in to unlock the live workspace.
            </p>
            <Button asChild size="sm" className="mt-1">
              <Link href="/sign-in">Sign in with wallet</Link>
            </Button>
          </>
        )}
      </footer>
    </aside>
  );
}
