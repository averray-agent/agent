import { KindChip, type ReceiptKind } from "./KindChip";

export interface ShapeEntry {
  kind: ReceiptKind;
  title: string;
  body: React.ReactNode;
  fields: string[];
}

export interface ReceiptShapesLegendProps {
  shapes: ShapeEntry[];
}

export function ReceiptShapesLegend({ shapes }: ReceiptShapesLegendProps) {
  return (
    <section className="flex flex-col gap-3">
      <p
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)]" />
        Receipt shapes
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {shapes.map((shape) => (
          <ShapeCard key={shape.kind} shape={shape} />
        ))}
      </div>
    </section>
  );
}

function ShapeCard({ shape }: { shape: ShapeEntry }) {
  return (
    <article className="flex flex-col gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-3.5">
      <span className="inline-flex self-start">
        <KindChip kind={shape.kind} />
      </span>
      <span className="font-[family-name:var(--font-display)] text-[13px] font-bold text-[var(--avy-ink)]">
        {shape.title}
      </span>
      <span className="font-[family-name:var(--font-body)] text-[12px] leading-[1.5] text-[var(--avy-muted)]">
        {shape.body}
      </span>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {shape.fields.map((f) => (
          <span
            key={f}
            className="rounded-[4px] bg-[color:rgba(17,19,21,0.05)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {f}
          </span>
        ))}
      </div>
    </article>
  );
}
