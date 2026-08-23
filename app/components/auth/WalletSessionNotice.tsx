"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { disconnectWallet } from "@/lib/auth/wallet-provider.js";
import { useAuth } from "@/lib/auth/use-auth";
import { useWalletConnection } from "@/lib/auth/use-wallet-provider";

export function WalletSessionNotice() {
  const auth = useAuth();
  const wallet = useWalletConnection();
  const siweExpired = auth.lastReason === "siwe_expired" || auth.lastReason === "token_refresh_rejected";

  if (siweExpired) {
    return (
      <div className="border-b border-[color:rgba(167,97,34,0.32)] bg-[var(--warn-soft)] px-5 py-3 text-sm text-[var(--ink)]" data-session-expiry="siwe">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-3">
          <span>Your Averray sign-in expired. Re-sign the SIWE message to continue.</span>
          <Button asChild size="sm"><Link href="/sign-in">Re-sign</Link></Button>
        </div>
      </div>
    );
  }

  if (wallet.status === "session_expired") {
    return (
      <div className="border-b border-[var(--line)] bg-[#ebe7da] px-5 py-3 text-sm text-[var(--ink)]" data-session-expiry="walletconnect">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-3">
          <span>Your wallet pairing expired. Reconnect your wallet to sign again. Your Averray sign-in is separate.</span>
          <Button asChild size="sm" variant="secondary"><Link href="/sign-in">Reconnect wallet</Link></Button>
        </div>
      </div>
    );
  }

  if (wallet.status === "connected" && wallet.kind === "walletconnect") {
    return (
      <div className="border-b border-[var(--line)] bg-[var(--paper)] px-5 py-2 text-xs text-[var(--muted)]" data-session-expiry="active">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-3">
          <span>MetaMask mobile is connected for signing. SIWE and wallet pairing expire independently.</span>
          <button className="font-semibold text-[var(--ink)] underline underline-offset-4" type="button" onClick={() => void disconnectWallet()}>
            Disconnect wallet pairing
          </button>
        </div>
      </div>
    );
  }

  return null;
}
