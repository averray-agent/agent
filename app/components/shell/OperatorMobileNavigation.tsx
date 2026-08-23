"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Gauge, Menu, ScrollText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ChainTicker } from "@/components/shell/ChainTicker";
import { OPERATOR_NAV_GROUPS } from "@/components/shell/OperatorRoutes";
import { useAuth } from "@/lib/auth/use-auth";
import { useWalletConnection } from "@/lib/auth/use-wallet-provider";
import { disconnectWallet } from "@/lib/auth/wallet-provider.js";
import { signOut } from "@/lib/auth/siwe";
import { shortAddress } from "@/lib/format";
import {
  formatOperatorSessionExpiry,
  updateMoreSheetState,
} from "@/lib/ui/mobile-operator.js";
import { cn } from "@/lib/utils/cn";

const PRIMARY_ITEMS = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: Gauge },
  { href: "/receipts", label: "Receipts", icon: ScrollText },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OperatorMobileNavigation() {
  const pathname = usePathname();
  const auth = useAuth();
  const wallet = useWalletConnection();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setMoreOpen((open) => updateMoreSheetState(open, "navigate"));
  }, [pathname]);

  const walletAddress = auth.wallet ?? wallet.account;
  const signingSession = wallet.kind === "walletconnect"
    ? formatOperatorSessionExpiry(wallet.sessionExpiresAt)
    : wallet.status === "connected"
      ? "Browser wallet · no protocol expiry"
      : "Not connected";

  return (
    <Dialog.Root
      open={moreOpen}
      onOpenChange={(open) => setMoreOpen((current) => updateMoreSheetState(current, open ? "open" : "close"))}
    >
      <nav
        aria-label="Operator routes"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[var(--line)] bg-[color:rgba(255,253,247,0.96)] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 shadow-[0_-12px_32px_rgba(34,43,36,0.08)] backdrop-blur-xl min-[1080px]:hidden"
        data-testid="operator-mobile-bottom-bar"
      >
        {PRIMARY_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-[10px] px-1 font-[family-name:var(--font-display)] text-[10px] font-bold",
                active
                  ? "bg-[var(--accent-soft)] text-[var(--accent-hover)]"
                  : "text-[var(--muted)]",
              )}
            >
              <Icon aria-hidden className="h-[18px] w-[18px]" />
              {item.label}
            </Link>
          );
        })}
        <Dialog.Trigger asChild>
          <button
            type="button"
            onClick={() => setMoreOpen((open) => updateMoreSheetState(open, "open"))}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-[10px] px-1 font-[family-name:var(--font-display)] text-[10px] font-bold",
              moreOpen ? "bg-[var(--accent-soft)] text-[var(--accent-hover)]" : "text-[var(--muted)]",
            )}
            aria-label="Open full operator route menu"
          >
            <Menu aria-hidden className="h-[18px] w-[18px]" />
            More
          </button>
        </Dialog.Trigger>
      </nav>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[color:rgba(17,19,21,0.34)] backdrop-blur-sm min-[1080px]:hidden" />
        <Dialog.Content
          className="fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-[22px] border border-[var(--line)] bg-[var(--paper-solid)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-[0_-24px_64px_rgba(34,43,36,0.18)] outline-none md:inset-y-0 md:left-auto md:w-[360px] md:rounded-none md:rounded-l-[22px] md:px-5 md:pt-6 min-[1080px]:hidden"
          data-testid="operator-more-sheet"
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-4">
            <div>
              <Dialog.Title className="font-[family-name:var(--font-display)] text-xl font-bold text-[var(--ink)]">
                Control room
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-[var(--muted)]">
                Navigation and active wallet sessions.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close operator menu"
                onClick={() => setMoreOpen((open) => updateMoreSheetState(open, "close"))}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[var(--line)] text-[var(--muted)]"
              >
                <X aria-hidden className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="grid gap-5 py-5">
            {OPERATOR_NAV_GROUPS.map((group) => (
              <section key={group.label} aria-labelledby={`mobile-nav-${group.label}`}>
                <h2
                  id={`mobile-nav-${group.label}`}
                  className="mb-2 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--muted)]"
                >
                  {group.label}
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(pathname, item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-11 items-center gap-2 rounded-[10px] border px-3 text-sm font-semibold",
                          active
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-hover)]"
                            : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink)]",
                        )}
                      >
                        <Icon aria-hidden className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <section className="grid gap-3 border-t border-[var(--line)] py-5" aria-label="Wallet sessions">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Wallet</p>
                <p className="truncate font-[family-name:var(--font-mono)] text-sm text-[var(--ink)]">
                  {walletAddress ? shortAddress(walletAddress) : "Unavailable"}
                </p>
              </div>
              <ChainTicker />
            </div>
            <dl className="grid gap-2 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-3 text-xs">
              <div className="grid gap-0.5">
                <dt className="font-semibold text-[var(--ink)]">Averray sign-in expiry</dt>
                <dd className="break-all font-[family-name:var(--font-mono)] text-[var(--muted)]">
                  {formatOperatorSessionExpiry(auth.expiresAt)}
                </dd>
              </div>
              <div className="grid gap-0.5 border-t border-[var(--line)] pt-2">
                <dt className="font-semibold text-[var(--ink)]">Wallet signing expiry</dt>
                <dd className="break-all font-[family-name:var(--font-mono)] text-[var(--muted)]">{signingSession}</dd>
              </div>
            </dl>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="min-h-11 rounded-[10px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 text-sm font-semibold text-[var(--ink)]"
                onClick={() => {
                  setMoreOpen((open) => updateMoreSheetState(open, "sign_out"));
                  void signOut();
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                className="min-h-11 rounded-[10px] border border-[var(--line)] bg-[var(--paper-solid)] px-3 text-sm font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={wallet.status !== "connected"}
                onClick={() => {
                  setMoreOpen((open) => updateMoreSheetState(open, "disconnect"));
                  void disconnectWallet();
                }}
              >
                Disconnect
              </button>
            </div>
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
