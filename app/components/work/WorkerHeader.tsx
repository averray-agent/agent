"use client";

import Link from "next/link";
import { BriefcaseBusiness, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/format";
import { signOut } from "@/lib/auth/siwe";
import { useAuth } from "@/lib/auth/use-auth";

export function WorkerHeader() {
  const auth = useAuth();
  const operator = auth.roles.some((role) => role === "admin" || role === "verifier");

  return (
    <header className="border-b border-[var(--line)] bg-[color:rgba(251,249,244,0.92)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/work" className="flex items-center gap-3" aria-label="Averray paid work">
          <span className="grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
            A
          </span>
          <span>
            <strong className="block font-[family-name:var(--font-display)] text-base leading-tight">Averray</strong>
            <span className="text-xs text-[var(--muted)]">Paid work</span>
          </span>
        </Link>
        <nav className="flex items-center gap-2" aria-label="Worker navigation">
          <Link className="hidden items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--paper)] sm:inline-flex" href="/work">
            <BriefcaseBusiness className="h-4 w-4" />
            Find work
          </Link>
          {operator ? (
            <Link className="rounded-[var(--radius)] px-3 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]" href="/overview">
              Operator room
            </Link>
          ) : null}
          {auth.authenticated ? (
            <>
              <span className="hidden font-mono text-xs text-[var(--muted)] md:inline">{shortAddress(auth.wallet)}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void signOut()}
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          ) : (
            <span className="text-xs text-[var(--muted)]">No wallet needed to browse</span>
          )}
        </nav>
      </div>
    </header>
  );
}
