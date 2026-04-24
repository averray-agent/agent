import type { ReactNode } from "react";
import { TreasuryPanel } from "./TreasuryPanel";

export interface PolicyItem {
  tag: string;
  name: string;
  meta: ReactNode;
  signerNote: ReactNode;
}

export interface PolicyGateFooterProps {
  items: PolicyItem[];
  sub: string;
}

export function PolicyGateFooter({ items, sub }: PolicyGateFooterProps) {
  return (
    <TreasuryPanel
      eyebrow="Policy gate"
      title="Policies currently governing this surface"
      sub={sub}
    >
      <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
        {items.map((item) => (
          <PolicyCard key={item.tag} item={item} />
        ))}
      </div>
    </TreasuryPanel>
  );
}

function PolicyCard({ item }: { item: PolicyItem }) {
  return (
    <div className="grid gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[#faf8f1] px-3.5 py-3">
      <span
        className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
        style={{ letterSpacing: 0 }}
      >
        {item.tag}
      </span>
      <span className="font-[family-name:var(--font-display)] text-[13px] font-bold leading-[1.3] text-[var(--avy-ink)]">
        {item.name}
      </span>
      <span
        className="font-[family-name:var(--font-mono)] text-[11px] leading-[1.45] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {item.meta}
      </span>
      <span
        className="mt-0.5 flex items-center gap-1.5 border-t border-dashed border-[var(--avy-line-soft)] pt-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {item.signerNote}
      </span>
    </div>
  );
}
