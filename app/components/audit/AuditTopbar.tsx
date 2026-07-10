"use client";

import { useEffect, useState } from "react";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";

const pad = (n: number) => String(n).padStart(2, "0");

export function AuditTopbar({
  freshness,
  onExportCsv,
  exportDisabled = false,
  onVerifyManifest,
  verifyDisabled = false,
}: {
  freshness?: FreshnessState;
  onExportCsv: () => void;
  exportDisabled?: boolean;
  onVerifyManifest: () => void;
  verifyDisabled?: boolean;
}) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
    };
    tick();
    const tId = setInterval(tick, 1000);
    return () => {
      clearInterval(tId);
    };
  }, []);

  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.08em" }}
        >
          <span>Governance</span>
          <span className="opacity-40">/</span>
          <span className="text-[var(--avy-ink)]">Audit log</span>
        </div>
        <span
          className="inline-flex items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          suppressHydrationWarning
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2s_infinite]" />
          <span className="text-[var(--avy-ink)]">{time || "—"} UTC</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        {freshness ? <DataFreshnessPill state={freshness} /> : null}
        <button
          type="button"
          onClick={onExportCsv}
          disabled={exportDisabled}
          title={exportDisabled ? "A non-empty live audit view is required before exporting." : "Download the current authenticated audit view as CSV."}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform enabled:hover:-translate-y-px enabled:hover:border-[color:rgba(30,102,66,0.24)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ letterSpacing: "0.04em" }}
        >
          ⤓ Export CSV
        </button>
        <button
          type="button"
          onClick={onVerifyManifest}
          disabled={verifyDisabled}
          title={verifyDisabled ? "A non-empty live audit feed is required before verification." : "Verify the manifest for the authenticated audit response."}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform enabled:hover:-translate-y-px enabled:hover:bg-[var(--avy-accent-2)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ letterSpacing: "0.04em" }}
        >
          ✓ Verify manifest
        </button>
      </div>
    </header>
  );
}
