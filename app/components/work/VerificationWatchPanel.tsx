"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, ExternalLink, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { publicProfileUrl } from "@/lib/agents/public-profile.js";
import { swrFetcher } from "@/lib/api/client";
import { publicReceiptUrl, verificationDepthStatement } from "@/lib/work/human-work.js";
import { watchSessionToTerminal } from "@/lib/work/verification-watch.js";
import type { HumanJobDefinition, WorkSessionRecord } from "./types";

type WatchState = {
  kind: "checking" | "retrying" | "stalled" | "terminal";
  session: WorkSessionRecord | null;
  message?: string;
};

export function VerificationWatchPanel({
  sessionId,
  initialSession,
  definition
}: {
  sessionId: string;
  initialSession: WorkSessionRecord;
  definition?: HumanJobDefinition;
}) {
  const [retry, setRetry] = useState(0);
  const [watch, setWatch] = useState<WatchState>({ kind: "checking", session: initialSession });

  useEffect(() => {
    const controller = new AbortController();
    setWatch({ kind: "checking", session: initialSession });
    void watchSessionToTerminal({
      sessionId,
      fetcher: swrFetcher,
      signal: controller.signal,
      onUpdate(update: { status: string; session?: WorkSessionRecord }) {
        setWatch((current) => ({
          kind: update.status === "retrying" ? "retrying" : "checking",
          session: update.session ?? current.session
        }));
      }
    }).then((result: { status: string; session?: WorkSessionRecord; message?: string }) => {
      if (controller.signal.aborted || result.status === "aborted") return;
      if (result.status === "terminal") {
        setWatch({ kind: "terminal", session: result.session ?? null });
      } else {
        setWatch({ kind: "stalled", session: result.session ?? null, message: result.message });
      }
    });
    return () => controller.abort();
  }, [initialSession, retry, sessionId]);

  const receiptHref = publicReceiptUrl(watch.session?.workReceiptId);
  const profileHref = publicProfileUrl(watch.session?.wallet);
  const status = watch.session?.status ?? watch.session?.state ?? "submitted";

  if (watch.kind === "terminal") {
    return (
      <section className="rounded-[var(--radius-lg)] border border-[color:rgba(30,102,66,0.3)] bg-[var(--paper-solid)] p-6 shadow-[var(--shadow-sm)]">
        <Badge tone={status === "resolved" ? "success" : "warn"}><CheckCircle2 className="h-3.5 w-3.5" />{status.replace(/_/gu, " ")}</Badge>
        <h2 className="mt-4 text-2xl font-semibold">Verification reached a terminal result.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{verificationDepthStatement(definition)}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {receiptHref ? (
            <a className="inline-flex h-10 items-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-4 text-sm font-semibold text-white" href={receiptHref} target="_blank" rel="noreferrer">
              Public receipt <ExternalLink className="h-4 w-4" />
            </a>
          ) : (
            <span className="rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]">The terminal session does not expose a public receipt id yet.</span>
          )}
          {profileHref ? (
            <a className="inline-flex h-10 items-center gap-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] px-4 text-sm font-semibold" href={profileHref} target="_blank" rel="noreferrer">
              Public profile <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </section>
    );
  }

  if (watch.kind === "stalled") {
    return (
      <section className="rounded-[var(--radius-lg)] border border-[color:rgba(167,97,34,0.3)] bg-[var(--paper-solid)] p-6 shadow-[var(--shadow-sm)]">
        <Badge tone="warn">Status check paused</Badge>
        <h2 className="mt-4 text-2xl font-semibold">Verification has not reported a terminal result.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{watch.message || "The bounded status reader stopped. Nothing has been marked complete."}</p>
        <Button className="mt-5" variant="secondary" onClick={() => setRetry((value) => value + 1)}><RefreshCw className="h-4 w-4" /> Retry status check</Button>
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-6 shadow-[var(--shadow-sm)]" aria-live="polite">
      <Badge tone="accent"><Clock3 className="h-3.5 w-3.5" />{watch.kind === "retrying" ? "Retrying status" : "Verification running"}</Badge>
      <h2 className="mt-4 text-2xl font-semibold">The verifier has your submission.</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">Current session state: {status}. This reader checks every few seconds and stops after 90 seconds rather than hanging indefinitely.</p>
      <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{verificationDepthStatement(definition)}</p>
    </section>
  );
}
