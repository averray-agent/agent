import { CircleDollarSign, Clock3, Fuel, LockKeyhole, ShieldCheck, WalletCards } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatAmount } from "@/lib/format";

interface ClaimTerms {
  rewardAmount: number | null;
  rewardAsset: string;
  netReward: number | null;
  stake: number | null;
  ttlSeconds: number | null;
  waiverEligible: boolean;
  waiverApplied: boolean;
  gasBrokered: boolean;
  eligible: boolean;
  refusalReason: string | null;
}

export function ClaimHonestyPanel({ terms, walletChecked }: { terms: ClaimTerms; walletChecked: boolean }) {
  return (
    <Card className={terms.refusalReason ? "border-[color:rgba(167,97,34,0.38)]" : ""}>
      <CardContent className="py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Before you claim</p>
            <h2 className="mt-2 text-xl font-semibold">The money and time terms</h2>
          </div>
          <Badge tone={terms.refusalReason ? "warn" : walletChecked && terms.eligible ? "success" : "muted"}>
            {terms.refusalReason ? "Claim blocked" : walletChecked ? "Wallet checked" : "Public estimate"}
          </Badge>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Fact icon={CircleDollarSign} label="Listed reward" value={formatAmount(terms.rewardAmount ?? undefined, terms.rewardAsset)} />
          <Fact
            icon={WalletCards}
            label="Net estimate"
            value={terms.netReward === null ? "Calculated after wallet check" : formatAmount(terms.netReward, terms.rewardAsset)}
          />
          <Fact
            icon={LockKeyhole}
            label="Bond / stake"
            value={terms.stake && terms.stake > 0 ? formatAmount(terms.stake, terms.rewardAsset) : "No claim lock shown"}
          />
          <Fact icon={Fuel} label="Gas" value={terms.gasBrokered ? "Operator-brokered" : "Paid by worker wallet"} />
          <Fact
            icon={ShieldCheck}
            label="Fresh-wallet waiver"
            value={terms.waiverApplied ? "Applies to this claim" : terms.waiverEligible ? "Eligible; confirmed after wallet check" : "Not advertised"}
          />
          <Fact icon={Clock3} label="Claim TTL" value={formatTtl(terms.ttlSeconds)} />
        </div>
        {terms.refusalReason ? (
          <p className="mt-5 rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm font-medium text-[var(--warn)]" role="alert">
            This claim would be refused: {terms.refusalReason.replace(/_/gu, " ")}.
          </p>
        ) : null}
        {!walletChecked ? (
          <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">
            These are public job terms. The wallet check reads the live preflight, eligibility, and net-reward results before any claim is sent.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" />{label}
      </div>
      <p className="mt-2 text-sm font-semibold text-[var(--ink)]">{value}</p>
    </div>
  );
}

function formatTtl(seconds: number | null): string {
  if (!Number.isFinite(Number(seconds))) return "Not advertised";
  const minutes = Math.round(Number(seconds) / 60);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}
