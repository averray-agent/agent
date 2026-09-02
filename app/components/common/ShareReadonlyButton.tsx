"use client";

import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { swrFetcher } from "@/lib/api/client";
import { buildShareHref } from "@/lib/share/read-only-share";

type ShareSurface = "agent" | "session" | "dispute" | "policy";

type ShareResponse = {
  appPath?: string;
  share?: {
    expiresAt?: string;
  };
};

export function ShareReadonlyButton({
  surface,
  id,
  label = "Copy read-only link",
  ttlSeconds = 7 * 24 * 60 * 60,
  className = "",
}: {
  surface: ShareSurface;
  id: string;
  label?: string;
  ttlSeconds?: number;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "working" | "copied" | "failed">("idle");

  const copyShare = async () => {
    if (!id || state === "working") return;
    setState("working");
    try {
      const response = await swrFetcher<ShareResponse>([
        "/shares",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface, id, ttlSeconds }),
        },
      ]);
      const href = buildShareHref(response.appPath, window.location.origin);
      if (!href) throw new Error("share response missing appPath");
      await navigator.clipboard.writeText(href);
      setState("copied");
      setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
      setTimeout(() => setState("idle"), 2200);
    }
  };

  const Icon = state === "copied" ? Check : Link2;
  const text =
    state === "working"
      ? "Signing"
      : state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Failed"
          : label;

  return (
    <button
      type="button"
      onClick={copyShare}
      disabled={state === "working"}
      title="Create a signed read-only URL that expires automatically"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2 py-1.5 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)] disabled:cursor-wait disabled:opacity-70 ${className}`}
      style={{ letterSpacing: "0.06em" }}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}
