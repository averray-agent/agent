"use client";

import Link from "next/link";
import { signOut } from "@/lib/auth/siwe";

export function OperatorRoleWall() {
  return (
    <section
      className="fixed inset-0 z-[100] grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12"
      data-testid="operator-role-wall"
    >
      <div className="w-full max-w-[480px] rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow-sm)]">
        <p className="eyebrow">Operator control room</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          This is the operator control room, and this wallet doesn&apos;t have operator access.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
          Your wallet session is valid. Use the worker board with this wallet, or sign out and use an authorized operator identity.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-4 text-sm font-semibold text-white"
            href="/work"
          >
            Find paid work
          </Link>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)]"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}
