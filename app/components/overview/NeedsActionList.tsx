import Link from "next/link";
import type { ReactNode } from "react";
import { SectionHead } from "./SectionHead";
import { cn } from "@/lib/utils/cn";

export type AlertTone = "warn" | "accent";

export interface AlertItem {
  id: string;
  tone: AlertTone;
  title: string;
  ref?: string;
  body: ReactNode;
  ctaLabel: string;
  ctaHref: string;
}

export interface NeedsActionListProps {
  alerts: AlertItem[];
  meta?: string;
}

export function NeedsActionList({ alerts, meta }: NeedsActionListProps) {
  return (
    <section>
      <SectionHead
        title="Needs action now"
        meta={meta ?? `${alerts.length} open`}
      />
      <div className="flex flex-col gap-2">
        {alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} />
        ))}
      </div>
    </section>
  );
}

function AlertRow({ alert }: { alert: AlertItem }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[10px_1fr_auto] items-center gap-4 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-[0.95rem_1.1rem] shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.22)]",
        alert.tone === "warn" && "border-l-[3px] border-l-[var(--avy-warn)]",
        alert.tone === "accent" && "border-l-[3px] border-l-[var(--avy-accent)]"
      )}
    >
      <span
        className={cn(
          "mt-1.5 h-2.5 w-2.5 self-start rounded-full",
          alert.tone === "warn" &&
            "bg-[var(--avy-warn)] shadow-[0_0_0_3px_var(--avy-warn-soft)]",
          alert.tone === "accent" &&
            "bg-[var(--avy-accent)] shadow-[0_0_0_3px_var(--avy-accent-soft)]"
        )}
      />
      <div className="min-w-0">
        <h3 className="m-0 mb-0.5 font-[family-name:var(--font-display)] text-[15px] font-bold leading-[1.25] text-[var(--avy-ink)]">
          {alert.title}
          {alert.ref ? (
            <span className="ml-2 font-[family-name:var(--font-mono)] text-[12.5px] font-medium text-[var(--avy-muted)]">
              {alert.ref}
            </span>
          ) : null}
        </h3>
        <p className="m-0 font-[family-name:var(--font-body)] text-[13.5px] leading-[1.45] text-[var(--avy-muted)]">
          {alert.body}
        </p>
      </div>
      <Link
        href={alert.ctaHref}
        className="inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.04em" }}
      >
        {alert.ctaLabel}
      </Link>
    </div>
  );
}
