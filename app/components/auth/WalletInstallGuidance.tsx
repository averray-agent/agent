"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { WalletProviderState } from "@/lib/auth/use-wallet-provider";

export function WalletInstallGuidance({
  provider,
  showBrowseLink = false,
}: {
  provider: WalletProviderState;
  showBrowseLink?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-md)] border p-4 text-sm leading-relaxed ${provider === "unavailable" ? "border-[color:rgba(167,97,34,0.46)] bg-[var(--warn-soft)] text-[var(--ink)]" : "border-[var(--line)] bg-[var(--paper)] text-[var(--muted)]"}`}
      data-wallet-guidance
      data-wallet-provider={provider}
    >
      <p>
        Your wallet is your sign-in and account identity. It ties your runs,
        receipts, payments, and reputation to one address you control.
      </p>
      <p className="mt-2">Need one? Install a browser wallet, then return and connect it.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href="https://metamask.io/download" target="_blank" rel="noopener noreferrer">
            Install MetaMask
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href="https://talisman.xyz/download/" target="_blank" rel="noopener noreferrer">
            Install Talisman
          </a>
        </Button>
      </div>
      <p className="mt-3">
        SIWE is the only sign-in door. There is no email signup by design.{" "}
        <Link href="https://averray.com" className="text-[var(--accent)] underline underline-offset-2">
          What is Averray?
        </Link>
      </p>
      {showBrowseLink ? (
        <Link href="/work" className="mt-3 inline-flex font-semibold text-[var(--accent)] underline underline-offset-4">
          Browse paid work without a wallet →
        </Link>
      ) : null}
    </div>
  );
}
