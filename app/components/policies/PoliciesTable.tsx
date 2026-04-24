"use client";

import { cn } from "@/lib/utils/cn";
import { SIGNERS } from "./signers";
import { SeverityPill, StatePill, ScopePill } from "./pills";
import { SignerAvatar, SignerAvatarRow } from "./SignerAvatar";
import type { Policy } from "./types";

export interface PoliciesTableProps {
  rows: Policy[];
  totalCount: number;
  selectedId: string | null;
  onSelect: (p: Policy) => void;
}

function relativeTime(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const [, y, mo, d, hh = "00", mm = "00"] = m;
  const then = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

export function PoliciesTable({
  rows,
  totalCount,
  selectedId,
  onSelect,
}: PoliciesTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold">
          All policies
        </h3>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          sorted by last change · newest first · {rows.length} of {totalCount}
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th width="22%">Tag</Th>
              <Th width="10%">Scope</Th>
              <Th width="11%">Severity</Th>
              <Th width="14%">Signers</Th>
              <Th width="11%">Active since</Th>
              <Th>Last change</Th>
              <Th width="10%">State</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="p-8 text-center font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  No policies match these filters.
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const selected = p.id === selectedId;
                const author = SIGNERS[p.lastChange.author];
                return (
                  <tr
                    key={p.id}
                    onClick={() => onSelect(p)}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-white/55",
                      selected && "bg-[color:rgba(30,102,66,0.06)]"
                    )}
                  >
                    <Td>
                      <span
                        className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {p.tag}
                      </span>
                    </Td>
                    <Td>
                      <ScopePill label={p.scopeLabel} />
                    </Td>
                    <Td>
                      <SeverityPill severity={p.severity} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span
                          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
                          style={{ letterSpacing: 0 }}
                        >
                          {p.signersReq} of {p.signersTotal}
                        </span>
                        <SignerAvatarRow
                          signerKeys={p.signerKeys}
                          approvals={p.approvals}
                          size={20}
                        />
                      </div>
                    </Td>
                    <Td>
                      <span
                        className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {p.activeSince ?? "—"}
                      </span>
                    </Td>
                    <Td>
                      <div
                        className="text-[13px] leading-tight text-[var(--avy-ink)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {p.lastChange.text}
                      </div>
                      <div
                        className="mt-0.5 flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        <SignerAvatar signerKey={p.lastChange.author} size={14} />
                        <span>
                          {author?.addr.slice(0, 6)}… · {relativeTime(p.lastChange.at)}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <StatePill state={p.state} />
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <footer
        className="flex items-center justify-between gap-3 border-t border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.5)] px-4 py-3 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>
          Showing <b className="font-semibold text-[var(--avy-ink)]">{rows.length}</b> of{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{totalCount}</b> policies
        </span>
        <button
          type="button"
          className="cursor-pointer border-b border-dashed border-[color:rgba(30,102,66,0.4)] pb-px text-[var(--avy-accent)] hover:text-[var(--avy-accent-2)]"
        >
          Import from /schemas/policies →
        </button>
      </footer>
    </div>
  );
}

function Th({ children, width }: { children: React.ReactNode; width?: string }) {
  return (
    <th
      className="border-b border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.6)] px-4 py-2.5 text-left font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap"
      style={{ letterSpacing: "0.12em", width }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-b border-[var(--avy-line-soft)] px-4 py-3 align-middle last:border-b-0">
      {children}
    </td>
  );
}
