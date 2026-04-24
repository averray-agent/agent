import { cn } from "@/lib/utils/cn";
import type {
  DecisionKind,
  ReleaseDestination,
  StakeBreakdown,
} from "./types";

/**
 * Big frozen number + segmented bar showing worker/verifier/treasury
 * portions of the stake, then the three release destinations as radio
 * buttons. Destinations are disabled until the operator picks a
 * verdict in the DecisionPanel — at that point the valid destinations
 * for that verdict light up.
 */
export function StakeHoldPanel({
  total,
  breakdown,
  destination,
  onDestinationChange,
  decision,
  disabled,
}: {
  total: number;
  breakdown: StakeBreakdown;
  destination: ReleaseDestination | null;
  onDestinationChange: (d: ReleaseDestination) => void;
  decision: DecisionKind | null;
  disabled?: boolean;
}) {
  const workerPct = (breakdown.worker / total) * 100;
  const verifierPct = (breakdown.verifier / total) * 100;
  const treasuryPct = (breakdown.treasury / total) * 100;

  const allowedFor: Record<DecisionKind, ReleaseDestination[]> = {
    uphold: ["slash-to-treasury", "pay-verifier"],
    reject: ["return-to-depositor"],
    "request-more": [],
  };
  const allowed = decision ? allowedFor[decision] : [];

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-[color:rgba(167,97,34,0.28)] bg-[color:rgba(244,227,207,0.28)] p-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <span
            className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-warn)]"
            style={{ letterSpacing: "0.12em" }}
          >
            Stake frozen
          </span>
          <div
            className="mt-0.5 font-[family-name:var(--font-display)] text-[2.2rem] font-bold leading-none tabular-nums text-[var(--avy-warn)]"
            style={{ letterSpacing: "-0.01em" }}
          >
            {total}
            <span className="ml-1 text-[14px] font-medium text-[var(--avy-muted)]">
              DOT
            </span>
          </div>
        </div>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          released only on signed verdict
        </span>
      </div>

      <div>
        <div
          className="flex h-2.5 overflow-hidden rounded-full bg-[color:rgba(17,19,21,0.08)]"
          aria-label="Stake portions"
        >
          <span
            className="block bg-[var(--avy-accent)]"
            style={{ width: `${workerPct}%` }}
          />
          <span
            className="block bg-[var(--avy-blue)]"
            style={{ width: `${verifierPct}%` }}
          />
          <span
            className="block bg-[var(--avy-warn)]"
            style={{ width: `${treasuryPct}%` }}
          />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 font-[family-name:var(--font-mono)] text-[11px]">
          <PortionLegend
            dotClass="bg-[var(--avy-accent)]"
            label="Worker"
            value={breakdown.worker}
          />
          <PortionLegend
            dotClass="bg-[var(--avy-blue)]"
            label="Verifier"
            value={breakdown.verifier}
          />
          <PortionLegend
            dotClass="bg-[var(--avy-warn)]"
            label="Treasury"
            value={breakdown.treasury}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[color:rgba(167,97,34,0.22)] pt-3">
        <span
          className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Release destination
        </span>
        <div className="grid gap-1.5">
          <DestinationRadio
            id="return-to-depositor"
            label="Return to depositor"
            meta="Full unlock to the worker wallet. Run resumes."
            checked={destination === "return-to-depositor"}
            enabled={!disabled && allowed.includes("return-to-depositor")}
            onChange={() => onDestinationChange("return-to-depositor")}
          />
          <DestinationRadio
            id="pay-verifier"
            label="Pay verifier"
            meta="Stake portion routed to verifier for the catch."
            checked={destination === "pay-verifier"}
            enabled={!disabled && allowed.includes("pay-verifier")}
            onChange={() => onDestinationChange("pay-verifier")}
          />
          <DestinationRadio
            id="slash-to-treasury"
            label="Slash to treasury"
            meta="Worker portion forfeit per policy. Badge revoked."
            checked={destination === "slash-to-treasury"}
            enabled={!disabled && allowed.includes("slash-to-treasury")}
            onChange={() => onDestinationChange("slash-to-treasury")}
            tone="bad"
          />
        </div>
        {!decision ? (
          <p
            className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            Pick a verdict below to enable destinations.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PortionLegend({
  dotClass,
  label,
  value,
}: {
  dotClass: string;
  label: string;
  value: number;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[var(--avy-muted)]">
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
      <span className="text-[var(--avy-ink)]">{label}</span>
      <span className="ml-auto tabular-nums" style={{ letterSpacing: 0 }}>
        {value} DOT
      </span>
    </span>
  );
}

function DestinationRadio({
  id,
  label,
  meta,
  checked,
  enabled,
  onChange,
  tone,
}: {
  id: string;
  label: string;
  meta: string;
  checked: boolean;
  enabled: boolean;
  onChange: () => void;
  tone?: "bad";
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2 transition-colors",
        checked && enabled && tone === "bad"
          ? "border-[color:rgba(140,42,23,0.35)] bg-[color:rgba(243,210,201,0.55)]"
          : checked && enabled
            ? "border-[color:rgba(30,102,66,0.35)] bg-[var(--avy-accent-soft)]"
            : enabled
              ? "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] hover:border-[color:rgba(30,102,66,0.24)]"
              : "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] opacity-45 cursor-not-allowed"
      )}
    >
      <input
        type="radio"
        name="release-destination"
        value={id}
        checked={checked && enabled}
        disabled={!enabled}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 accent-[var(--avy-accent)]"
      />
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            "font-[family-name:var(--font-display)] text-[12.5px] font-bold",
            tone === "bad" ? "text-[#8c2a17]" : "text-[var(--avy-ink)]"
          )}
        >
          {label}
        </span>
        <span
          className="font-[family-name:var(--font-body)] text-[11.5px] leading-snug text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {meta}
        </span>
      </span>
    </label>
  );
}
