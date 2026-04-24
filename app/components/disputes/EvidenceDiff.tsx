import { cn } from "@/lib/utils/cn";
import type { EvidenceRow } from "./types";

/**
 * The centerpiece of the Disputes drawer.
 *
 * Two columns stacked over a field-by-field comparison table:
 *   - top: worker's submitted payload (dark terminal, warn tint)
 *   - top: verifier's expected payload (dark terminal, sage tint)
 *   - bottom: row-by-row field comparison with ✓/⚠/✕ icons and a
 *     divergence note when present.
 *
 * Fail rows get a deep-red left border so they're scannable.
 */
export function EvidenceDiff({
  workerPayload,
  expectedPayload,
  rows,
}: {
  workerPayload: string;
  expectedPayload: string;
  rows: EvidenceRow[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <PayloadColumn
          title="Worker submitted"
          sub="signed by respondent"
          raw={workerPayload}
          tone="warn"
        />
        <PayloadColumn
          title="Verifier expected"
          sub="per active policy"
          raw={expectedPayload}
          tone="sage"
        />
      </div>

      <div className="overflow-hidden rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)]">
        <header
          className="grid items-baseline gap-2 border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-3.5 py-2 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ gridTemplateColumns: "22px 1fr 1fr 1fr", letterSpacing: "0.12em" }}
        >
          <span />
          <span>Field</span>
          <span>Worker</span>
          <span>Expected</span>
        </header>
        <ul className="m-0 flex flex-col p-0">
          {rows.map((r, i) => (
            <DiffRow key={r.label + i} row={r} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PayloadColumn({
  title,
  sub,
  raw,
  tone,
}: {
  title: string;
  sub: string;
  raw: string;
  tone: "warn" | "sage";
}) {
  const frame =
    tone === "warn"
      ? "border-[color:rgba(167,97,34,0.35)]"
      : "border-[color:rgba(30,102,66,0.35)]";
  const label =
    tone === "warn" ? "text-[var(--avy-warn)]" : "text-[#9bd7b5]";
  return (
    <div className={cn("overflow-hidden rounded-[8px] border", frame)}>
      <div
        className={cn(
          "flex items-baseline justify-between border-b border-white/5 bg-[#0f1210] px-3 py-1.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
          label
        )}
        style={{ letterSpacing: "0.12em" }}
      >
        <span>{title}</span>
        <span
          className="font-[family-name:var(--font-mono)] text-[10.5px] font-medium opacity-70"
          style={{ letterSpacing: 0 }}
        >
          {sub}
        </span>
      </div>
      <pre
        className="m-0 max-h-[260px] overflow-auto bg-[#131715] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.55] text-[#e8e5dc]"
        style={{ letterSpacing: 0 }}
      >
        <code>{raw}</code>
      </pre>
    </div>
  );
}

function DiffRow({ row: r }: { row: EvidenceRow }) {
  return (
    <li
      className={cn(
        "grid items-start gap-2 border-b border-[var(--avy-line-soft)] px-3.5 py-2.5 last:border-b-0",
        r.match === "fail" && "border-l-[3px] border-l-[#8c2a17] bg-[color:rgba(243,210,201,0.2)]",
        r.match === "warn" && "border-l-[3px] border-l-[var(--avy-warn)] bg-[color:rgba(244,227,207,0.25)]"
      )}
      style={{ gridTemplateColumns: "22px 1fr 1fr 1fr" }}
    >
      <span
        className={cn(
          "mt-0.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold",
          r.match === "ok" &&
            "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
          r.match === "warn" &&
            "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
          r.match === "fail" && "bg-[#f3d2c9] text-[#8c2a17]"
        )}
      >
        {r.match === "ok" ? "✓" : r.match === "warn" ? "⚠" : "✕"}
      </span>
      <span
        className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        {r.label}
      </span>
      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[12px]",
          r.match === "ok" && "text-[var(--avy-ink)]",
          r.match === "warn" && "text-[var(--avy-warn)]",
          r.match === "fail" && "text-[#8c2a17]"
        )}
        style={{ letterSpacing: 0 }}
      >
        {r.worker}
      </span>
      <span className="flex flex-col">
        <span
          className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {r.expected}
        </span>
        {r.note ? (
          <span
            className="mt-0.5 font-[family-name:var(--font-body)] text-[11.5px] leading-snug text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {r.note}
          </span>
        ) : null}
      </span>
    </li>
  );
}
