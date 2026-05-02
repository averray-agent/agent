import type { Policy } from "./types";

export function PoliciesAggregateStrip({ policies }: { policies: Policy[] }) {
  const active = policies.filter((p) => p.state === "Active").length;
  const pending = policies.filter((p) => p.state === "Pending").length;
  const revisions30d = countRevisionsSince(policies, 30);
  const quorum = dominantQuorum(policies);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        label="Active policies"
        value={active}
        meta="gating · hard-stop · advisory"
      />
      <Card
        label="Pending proposals"
        value={pending}
        warn={pending > 0}
        meta={pending > 0 ? "awaiting signers · your queue" : "queue clear"}
      />
      <Card
        label="Revisions · 30d"
        value={revisions30d}
        meta={revisions30d > 0 ? "policy churn · last 30 days" : "no revisions in last 30 days"}
      />
      <Card
        label="Signer quorum"
        value={quorum.value}
        right={
          quorum.isDominant ? (
            <span
              className="inline-flex items-center rounded-[4px] bg-[var(--avy-accent-soft)] px-1.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.08em" }}
            >
              common
            </span>
          ) : undefined
        }
        meta={quorum.meta}
      />
    </div>
  );
}

function countRevisionsSince(policies: Policy[], days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return policies.reduce((count, policy) => {
    const history = Array.isArray(policy.history) ? policy.history : [];
    if (history.length) {
      return count + history.filter((item) => isSince(item.at, cutoff)).length;
    }
    return count + (isSince(policy.lastChange.at, cutoff) ? 1 : 0);
  }, 0);
}

function dominantQuorum(policies: Policy[]): {
  value: string;
  meta: string;
  isDominant: boolean;
} {
  const counts = new Map<string, number>();
  for (const policy of policies) {
    if (policy.signersReq > 0 && policy.signersTotal > 0) {
      const key = `${policy.signersReq} of ${policy.signersTotal}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (!counts.size) {
    return { value: "—", meta: "quorum not emitted", isDominant: false };
  }
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    value,
    meta: count === policies.length ? "all visible policies" : `${count} of ${policies.length} visible policies`,
    isDominant: count > 0,
  };
}

function isSince(value: unknown, cutoffMs: number): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= cutoffMs;
}

function Card({
  label,
  value,
  meta,
  warn,
  right,
}: {
  label: string;
  value: string | number;
  meta: string;
  warn?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <article
      className={
        "flex flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[8px] " +
        (warn ? "border-[color:rgba(167,97,34,0.35)] bg-[color:rgba(244,227,207,0.35)]" : "")
      }
    >
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </span>
      <div className="flex items-end justify-between gap-2">
        <span
          className="font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums text-[var(--avy-ink)]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {value}
        </span>
        {right}
      </div>
      <span
        className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {meta}
      </span>
    </article>
  );
}
