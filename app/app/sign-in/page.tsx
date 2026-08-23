"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth/use-auth";
import { routeAfterSignIn } from "@/lib/work/human-work.js";
import { WalletSignInFlow } from "@/components/auth/WalletSignInFlow";
import type { AuthSession } from "@/lib/auth/token-store";

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInFallback />}>
      <SignInContent />
    </Suspense>
  );
}

function SignInFallback() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12">
      <Card className="w-full max-w-[420px]">
        <CardContent className="py-8">
          <p className="text-sm text-[var(--muted)]">Preparing sign-in…</p>
        </CardContent>
      </Card>
    </main>
  );
}

function SignInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();

  const requestedNext = searchParams?.get("next") ?? undefined;

  useEffect(() => {
    if (auth.authenticated) {
      router.replace(routeAfterSignIn(auth.roles, requestedNext));
    }
  }, [auth.authenticated, auth.roles, requestedNext, router]);

  function handleSignedIn(session: AuthSession) {
    toast.success("Signed in. Welcome back.");
    router.replace(routeAfterSignIn(session.roles, requestedNext));
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12">
      <div className="grid w-full max-w-[960px] gap-8 md:grid-cols-[1.1fr_1fr] md:items-stretch">
        <section className="hidden flex-col justify-between rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow)] md:flex">
          <div>
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
                A
              </div>
              <strong className="font-[family-name:var(--font-display)] text-lg">
                Averray
              </strong>
            </div>
            <p className="eyebrow mt-6">Operator room</p>
            <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
              Sign in with your wallet.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
              Averray uses Sign-In with Ethereum. The message you sign attaches
              your wallet to runs, stakes, verifier receipts, and reputation —
              so the work you do becomes a legible trail.
            </p>
            <div className="mt-6">
              <p className="eyebrow">What you&apos;ll do here</p>
              <ul className="mt-2 grid gap-1.5 text-sm text-[var(--ink)]">
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
                    aria-hidden="true"
                  />
                  Claim open runs and submit work for verification.
                </li>
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
                    aria-hidden="true"
                  />
                  Hold and settle escrow in USDC — no platform token.
                </li>
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
                    aria-hidden="true"
                  />
                  Build portable reputation from signed receipts.
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-8 grid gap-2 text-xs text-[var(--muted)]">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
              SIWE (EIP-4361) · JWT with role claims pinned at sign-in
            </span>
            <span>Nonce lives 5 minutes. Token rotates every 24h.</span>
          </div>
        </section>

        <Card className="flex flex-col justify-between">
          <CardContent className="flex flex-col gap-5 py-8">
            <div className="flex items-center justify-between gap-4 md:hidden">
              <Link href="/work" className="flex items-center gap-2" aria-label="Averray paid work">
                <span className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">A</span>
                <strong className="font-[family-name:var(--font-display)]">Averray</strong>
              </Link>
              <Link href="/work" className="text-xs font-semibold text-[var(--accent)]">Browse work</Link>
            </div>
            {auth.lastReason === "siwe_expired" || auth.lastReason === "token_refresh_rejected" ? (
              <div className="rounded-[var(--radius)] border border-[color:rgba(167,97,34,0.38)] bg-[var(--warn-soft)] p-4" data-session-expiry="siwe">
                <p className="text-sm font-semibold text-[var(--ink)]">Your Averray sign-in expired.</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">Re-sign the readable SIWE message to continue. Your wallet pairing is separate and may still be active.</p>
              </div>
            ) : null}
            <WalletSignInFlow onSignedIn={handleSignedIn} />
            <div className="mt-2 border-t border-[var(--line)] pt-4 text-xs text-[var(--muted)]">
              SIWE is the only sign-in door. There is no email signup. <Link href="https://averray.com/agents/" className="text-[var(--accent)] underline-offset-2 hover:underline">Read the agent guide</Link>.
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
