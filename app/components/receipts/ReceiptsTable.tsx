"use client";

import { cn } from "@/lib/utils/cn";
import { KindChip, type ReceiptKind } from "./KindChip";
import { SignerAvatars, type Signer } from "./SignerAvatars";

export interface ReceiptRow {
  id: string;
  kind: ReceiptKind;
  subject: string;
  subjectSub: string;
  signers: Signer[];
  policy: string;
  size: string;
  signedAt: string;
}

export interface ReceiptsTableProps {
  rows: ReceiptRow[];
  selectedId: string | null;
  onSelect: (row: ReceiptRow) => void;
  shownCount: number;
  totalCount: number;
}

export function ReceiptsTable({
  rows,
  selectedId,
  onSelect,
  shownCount,
  totalCount,
}: ReceiptsTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[14px] font-bold">
          Signed receipts
        </h3>
        <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
          {shownCount} of {totalCount.toLocaleString()} · sorted by signed-at · newest first
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th width={110}>Receipt id</Th>
              <Th width={90}>Kind</Th>
              <Th>Subject</Th>
              <Th width={130}>Signers</Th>
              <Th>Policy</Th>
              <Th width={70}>Size</Th>
              <Th width={130}>Signed at</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = row.id === selectedId;
              return (
                <tr
                  key={row.id}
                  onClick={() => onSelect(row)}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-[rgba(255,252,240,0.75)]",
                    selected && "bg-[color:rgba(30,102,66,0.05)]"
                  )}
                >
                  <Td>
                    <span
                      className="font-[family-name:var(--font-mono)] text-[12.5px] font-semibold text-[var(--avy-accent)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.id}
                    </span>
                  </Td>
                  <Td>
                    <KindChip kind={row.kind} />
                  </Td>
                  <Td>
                    <div
                      className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.subject}
                    </div>
                    <div
                      className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.subjectSub}
                    </div>
                  </Td>
                  <Td>
                    <SignerAvatars signers={row.signers} />
                  </Td>
                  <Td>
                    <span
                      className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.policy}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.size}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {row.signedAt}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.5)] px-4 py-3 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <div className="flex items-center gap-3.5">
          <span>
            Showing <b className="font-semibold text-[var(--avy-ink)]">{shownCount}</b> of{" "}
            <b className="font-semibold text-[var(--avy-ink)]">{totalCount.toLocaleString()}</b>
          </span>
          <button
            type="button"
            className="cursor-pointer border-b border-dashed border-[color:rgba(30,102,66,0.4)] pb-px text-[var(--avy-accent)] hover:text-[var(--avy-accent-2)]"
          >
            load more
          </button>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-1.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] hover:border-[color:rgba(30,102,66,0.3)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.1em" }}
        >
          ⤓ Download signed manifest of this view
        </button>
      </footer>
    </div>
  );
}

function Th({
  children,
  width,
}: {
  children?: React.ReactNode;
  width?: number;
}) {
  return (
    <th
      className="border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-4 py-2.5 text-left font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap"
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
