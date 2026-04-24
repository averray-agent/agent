"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { signIn, WalletUnavailableError } from "@/lib/auth/siwe";
import { useAuth } from "@/lib/auth/use-auth";

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();
  const [pending, setPending] = useState(false);

  const next = searchParams?.get("next") ?? "/overview";

  useEffect(() => {
    if (auth.authenticated) router.replace(next);
  }, [auth.authenticated, next, router]);

  async function handleSignIn() {
    setPending(true);
    try {
      await signIn();
      toast.success("Signed in. Welcome back.");
      router.replace(next);
    } catch (error) {
      if (error instanceof WalletUnavailableError) {
        toast.error(error.message);
      } else {
        toast.error(error instanceof Error ? error.message : "Sign-in failed");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12">
      <div className="grid w-full max-w-[960px] gap-8 md:grid-cols-[1.1fr_1fr] md:items-stretch">
        <section className="flex flex-col justify-between rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow)]">
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
            <Badge tone="success" className="w-fit">
              Ready to authenticate
            </Badge>
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight">
                Connect a wallet
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
                MetaMask, Talisman, Rabby, or any EIP-1193 wallet injected into
                this browser will work.
              </p>
            </div>
            <Button
              size="lg"
              onClick={handleSignIn}
              disabled={pending}
              className="justify-center"
            >
              <Wallet className="h-4 w-4" />
              {pending ? "Signing…" : "Sign in with wallet"}
            </Button>
            {auth.lastReason ? (
              <p className="text-xs text-[var(--warn)]">{auth.lastReason}</p>
            ) : null}
            <div className="mt-2 border-t border-[var(--line)] pt-4 text-xs text-[var(--muted)]">
              Don&apos;t have a wallet yet?{" "}
              <Link href="https://averray.com/agents/" className="text-[var(--accent)] underline-offset-2 hover:underline">
                Read the agent guide
              </Link>
              .
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
