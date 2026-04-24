"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LoadedRunView } from "@/components/runs/LoadedRunView";

/**
 * Standalone fullscreen view for a single run.
 *
 * Linked from the Loaded-run panel's "Full view ↗" button. Lives at
 * `/runs/detail/?id=<runId>` (query param rather than a dynamic
 * `/runs/[id]/` segment so it works cleanly with the Next static
 * export on the VPS).
 *
 * What it's for: focused review of one run's evidence, PR, acceptance
 * criteria — no queue on the left competing for attention, no
 * recommendation strip below. Useful for disputes (reading a full
 * issue body + PR diff + comments), for sharing a direct link to a
 * co-signer, or for multi-tab triage ("I'll open these three claims
 * and cross-check them").
 */
export default function RunDetailPage() {
  return (
    <Suspense fallback={null}>
      <RunDetailInner />
    </Suspense>
  );
}

function RunDetailInner() {
  const searchParams = useSearchParams();
  const runId = searchParams?.get("id") ?? "run-2742";

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/runs"
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.04em" }}
        >
          ← Back to queue
        </Link>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          run <b className="text-[var(--avy-ink)]">{runId}</b> · fullscreen view
        </span>
      </div>

      {/*
       * `standaloneUrl` is intentionally omitted here — the "Full view"
       * button doesn't need to link to the page you're already on.
       * `showLifecycle` defaults to true so the single-run view is
       * self-complete (panel + lifecycle, no other rails).
       */}
      <LoadedRunView runId={runId} />
    </div>
  );
}
