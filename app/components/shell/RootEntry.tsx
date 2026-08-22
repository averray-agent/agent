"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/use-auth";

export function RootEntry() {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.checked && auth.authenticated) router.replace("/overview");
  }, [auth.authenticated, auth.checked, router]);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12">
      <div className="w-full max-w-[480px]">
        <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
            A
          </div>
          <strong className="font-[family-name:var(--font-display)] text-lg">Averray</strong>
        </div>
        <p className="eyebrow mt-6">Choose a door</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Work is visible before a wallet is required.</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
          Sign in with a wallet for the operator room, or browse live paid work publicly. An existing SIWE session opens the operator room in the background.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-4 text-sm font-semibold text-white" href="/sign-in">
            Sign in with wallet
          </Link>
          <Link className="inline-flex h-10 items-center justify-center rounded-[var(--radius)] border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)]" href="/work">
            Browse paid work
          </Link>
        </div>
        </section>
        <footer className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-[var(--muted)]">
          <Link href="https://averray.com">averray.com</Link>
          <Link href="https://averray.com/trust/">Trust</Link>
          <Link href="https://averray.com/agents/">Agents guide</Link>
        </footer>
      </div>
    </main>
  );
}
