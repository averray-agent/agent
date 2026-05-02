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
import {
  useAgents,
  useBadges,
  useDisputes,
  useJobs,
  usePolicies,
  useSessions,
} from "@/lib/api/hooks";

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

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Room",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/runs", label: "Runs", icon: Gauge },
      { href: "/receipts", label: "Receipts", icon: ScrollText },
      { href: "/agents", label: "Agents", icon: Users },
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
      { href: "/policies", label: "Policies", icon: ShieldCheck },
      { href: "/disputes", label: "Disputes", icon: AlertTriangle },
      { href: "/audit-log", label: "Audit log", icon: FileCheck2 },
    ],
  },
];

export function OperatorRail() {
  const pathname = usePathname();
  const auth = useAuth();
  const jobs = useJobs();
  const badges = useBadges();
  const agents = useAgents();
  const sessions = useSessions();
  const policies = usePolicies();
  const disputes = useDisputes();
  const counts: Record<string, number | string | undefined> = {
    "/runs": countOf(jobs.data),
    "/receipts": countOf(badges.data),
    "/agents": countOf(agents.data),
    "/sessions": countOf(sessions.data) ?? activeClaimCount(jobs.data),
    "/policies": countOf(policies.data),
    "/disputes": countOf(disputes.data),
  };

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
                  {(counts[item.href] ?? item.count) !== undefined ? (
                    <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]">
                      {counts[item.href] ?? item.count}
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

function countOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["items", "data", "jobs", "sessions", "agents", "badges", "policies", "disputes"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return undefined;
}

function activeClaimCount(value: unknown): number | undefined {
  const jobs = recordsFrom(value, ["jobs", "items", "data"]);
  if (!jobs) return undefined;
  const now = Date.now();
  return jobs.filter((job) => {
    const state = String(
      job.effectiveState ?? job.claimState ?? job.state ?? job.lifecycle ?? ""
    ).toLowerCase();
    const claimedBy =
      typeof job.claimedBy === "string" ||
      typeof job.worker === "string" ||
      typeof job.claimedByWallet === "string";
    const expiresAt =
      typeof job.claimExpiresAt === "string"
        ? Date.parse(job.claimExpiresAt)
        : undefined;
    const unexpired = !expiresAt || Number.isNaN(expiresAt) || expiresAt > now;
    return claimedBy && state.includes("claim") && unexpired;
  }).length;
}

function recordsFrom(
  value: unknown,
  keys: string[]
): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
