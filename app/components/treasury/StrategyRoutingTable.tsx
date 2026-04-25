import { cn } from "@/lib/utils/cn";
import { TreasuryPanel } from "./TreasuryPanel";

export type LaneStatus = "ok" | "warn" | "blocked";

export interface StrategyLane {
  id: string;
  laneTitle: string;
  laneMeta: string;
  strategyKind: string;
  allocated: string;
  coverage: number; // 0..100
  status: LaneStatus;
  statusLabel: string;
  allocateDisabled?: boolean;
  allocatePrimary?: boolean;
}

export interface StrategyRoutingTableProps {
  lanes: StrategyLane[];
  sub: string;
}

export function StrategyRoutingTable({ lanes, sub }: StrategyRoutingTableProps) {
  return (
    <TreasuryPanel
      eyebrow="Strategy routing"
      title="Allocation lanes"
      sub={sub}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th>Lane</Th>
              <Th>Strategy</Th>
              <Th align="right">Allocated</Th>
              <Th>Coverage</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => (
              <tr
                key={lane.id}
                className="cursor-pointer transition-colors hover:bg-white/55"
              >
                <Td>
                  <div className="text-[13.5px] font-semibold text-[var(--avy-ink)]">
                    {lane.laneTitle}
                  </div>
                  <div
                    className="mt-0.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                    style={{ letterSpacing: 0 }}
                  >
                    {lane.laneMeta}
                  </div>
                </Td>
                <Td>
                  <span className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]">
                    {lane.strategyKind}
                  </span>
                </Td>
                <Td align="right">
                  <span className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--avy-ink)]">
                    {lane.allocated}
                  </span>
                </Td>
                <Td>
                  <CoverageBar value={lane.coverage} status={lane.status} />
                </Td>
                <Td>
                  <StatusPill status={lane.status} label={lane.statusLabel} />
                </Td>
                <Td>
                  <div className="flex justify-end gap-1.5">
                    <TinyBtn
                      disabled
                      title="Strategy allocation is not yet wired to a live backend."
                    >
                      Allocate
                    </TinyBtn>
                    <TinyBtn
                      disabled
                      title="Strategy allocation is not yet wired to a live backend."
                    >
                      Deallocate
                    </TinyBtn>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TreasuryPanel>
  );
}

function Th({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-4 py-2.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]",
        align === "right" ? "text-right" : "text-left"
      )}
      style={{ letterSpacing: "0.12em" }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "border-b border-[var(--avy-line-soft)] px-4 py-3.5 align-middle last:border-b-0",
        align === "right" && "text-right"
      )}
    >
      {children}
    </td>
  );
}

function CoverageBar({ value, status }: { value: number; status: LaneStatus }) {
  return (
    <div className="grid min-w-[140px] grid-cols-[1fr_48px] items-center gap-2.5">
      <div className="h-1.5 overflow-hidden rounded-[3px] bg-[color:rgba(17,19,21,0.07)]">
        <span
          className={cn(
            "block h-full",
            status === "ok" && "bg-[var(--avy-accent)]",
            status === "warn" && "bg-[var(--avy-warn)]",
            status === "blocked" && "bg-[#8a2a1f]"
          )}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-right font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--avy-ink)]">
        {value}%
      </span>
    </div>
  );
}

const STATUS_CLASSES: Record<LaneStatus, string> = {
  ok: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  warn: "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
  blocked: "bg-[#f4d5d0] text-[#8a2a1f]",
};

function StatusPill({ status, label }: { status: LaneStatus; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full px-2.5 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase whitespace-nowrap",
        STATUS_CLASSES[status]
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function TinyBtn({
  children,
  primary,
  disabled,
  title,
}: {
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      className={cn(
        "rounded-[6px] border px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase transition-colors",
        primary
          ? "border-[var(--avy-accent)] bg-[var(--avy-accent)] text-[var(--fg-invert)]"
          : "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] text-[var(--avy-ink)] hover:border-[color:rgba(30,102,66,0.32)]",
        disabled && "cursor-not-allowed opacity-45"
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {children}
    </button>
  );
}
