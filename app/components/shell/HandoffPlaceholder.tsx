import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface HandoffPlaceholderProps {
  section: string;
  blocks: string[];
  apiHints: string[];
  extra?: ReactNode;
}

export function HandoffPlaceholder({ section, blocks, apiHints, extra }: HandoffPlaceholderProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col gap-5 py-6">
        <div className="flex items-center gap-2">
          <Badge tone="accent">Claude Design handoff pending</Badge>
          <Badge tone="muted">{section}</Badge>
        </div>
        <div>
          <p className="eyebrow">Blocks to design</p>
          <ul className="mt-2 grid gap-2 text-sm text-[var(--ink)] md:grid-cols-2">
            {blocks.map((block) => (
              <li
                key={block}
                className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2"
              >
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                <span>{block}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow">Wired API surface</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {apiHints.map((endpoint) => (
              <li
                key={endpoint}
                className="rounded-full border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]"
              >
                {endpoint}
              </li>
            ))}
          </ul>
        </div>
        {extra}
      </CardContent>
    </Card>
  );
}
