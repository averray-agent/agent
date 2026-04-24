"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils/cn";

export interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}

/**
 * Right-side slide-in sheet for read-only detail views.
 *
 * Shared primitive — lives in shell/ because it's reused across Receipts,
 * Sessions, Disputes, Audit log. Keeps the operator pattern consistent:
 * click row → detail drawer with a sig chain, evidence preview, linked
 * artifacts, and an optional verify/action panel at the bottom.
 *
 * Not a full modal — backdrop click, × button, and Escape all close it;
 * the page behind stays scrollable via the backdrop's blur.
 */
export function DetailDrawer({
  open,
  onClose,
  title,
  meta,
  children,
  width = 520,
}: DetailDrawerProps) {
  // Portal target lives on window.document; render nothing on the server
  // so SSR HTML matches the first client render. Flip `mounted` after the
  // initial client render to emit the portal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-[color:rgba(17,19,21,0.18)] backdrop-blur-sm transition-opacity duration-200",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-40 flex flex-col overflow-hidden border-l border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[-24px_0_60px_rgba(34,43,36,0.14)] transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
        style={{ width: `min(${width}px, 92vw)` }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--avy-line-soft)] px-5 py-4">
          <div className="min-w-0">
            {title}
            {meta ? <div className="mt-1.5">{meta}</div> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] font-[family-name:var(--font-mono)] text-sm text-[var(--avy-muted)] hover:border-[var(--avy-ink)] hover:text-[var(--avy-ink)]"
          >
            ✕
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 pb-6 pt-4">{children}</div>
      </aside>
    </>,
    document.body
  );
}

export function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}
