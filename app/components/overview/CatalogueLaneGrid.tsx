import type { CatalogueLaneCardData } from "@/lib/api/catalogue-lanes";
import { cn } from "@/lib/utils/cn";
import { SectionHead } from "./SectionHead";

export function CatalogueLaneGrid({ lanes, meta }: { lanes: CatalogueLaneCardData[]; meta: string }) {
  return (
    <section>
      <SectionHead title="Catalogue acquisition lanes" meta={meta} />
      {lanes.length ? (
        <div className="grid grid-cols-1 gap-[0.9rem] md:grid-cols-3">
          {lanes.map((lane) => <CatalogueLaneCard key={lane.id} lane={lane} />)}
        </div>
      ) : (
        <div className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 text-sm text-[var(--avy-muted)]">
          No catalogue lane status is available from the operator API.
        </div>
      )}
    </section>
  );
}

function CatalogueLaneCard({ lane }: { lane: CatalogueLaneCardData }) {
  return (
    <article className="grid gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[1.05rem_1.15rem] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
          {humanLaneName(lane.id)}
        </h3>
        <span className={cn(
          "rounded-full px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
          lane.paused
            ? "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]"
            : "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
        )}>
          {lane.paused ? "paused" : "posting"}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-[family-name:var(--font-mono)] text-[12px]">
        <Metric label="Spend · 24h" value={`${lane.spend24h} / ${lane.cap24h} USDC`} />
        <Metric label="Jobs posted" value={String(lane.jobsPosted24h)} />
        <Metric label="External claimants" value={`${lane.externalClaimantShare} · ${lane.externalClaimantCount}`} />
        <Metric label="Retained · 14d" value={String(lane.retainedExternalWorkers14d)} />
        <Metric label="Cost / retained · 30d" value={lane.costPerRetainedExternalWorker30d} />
      </dl>

      {!lane.costComplete ? (
        <p className="text-[11px] text-[var(--avy-warn)]">
          Incomplete cost: {lane.omittedSettlementCount} settlement receipt(s) omitted.
        </p>
      ) : null}
      <p className="border-t border-[var(--avy-line-soft)] pt-2 text-[12px] leading-relaxed text-[var(--avy-muted)]">
        <strong className="text-[var(--avy-ink)]">Hypothesis:</strong> {lane.hypothesis}
      </p>
      <p className="text-[12px] leading-relaxed text-[var(--avy-muted)]">
        <strong className="text-[var(--avy-ink)]">Stop:</strong> {lane.stopCondition}
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--avy-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[var(--avy-ink)]">{value}</dd>
    </div>
  );
}

function humanLaneName(id: string) {
  return id.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}
