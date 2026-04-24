import { cn } from "@/lib/utils/cn";
import { SignerAvatar } from "./SignerAvatar";
import type { Approval } from "./types";

export function ApprovalChain({ approvals }: { approvals: Approval[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {approvals.map((a) => (
        <Row key={a.key} approval={a} />
      ))}
    </div>
  );
}

function Row({ approval: a }: { approval: Approval }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-[8px] border px-3 py-2.5",
        a.state === "signed" &&
          "border-[color:rgba(30,102,66,0.22)] bg-[color:rgba(30,102,66,0.05)]",
        a.state === "pending" &&
          "border-[color:rgba(167,97,34,0.26)] bg-[color:rgba(244,227,207,0.35)]",
        a.state === "declined" &&
          "border-[color:rgba(140,42,23,0.32)] bg-[color:rgba(243,210,201,0.4)]"
      )}
    >
      <div className="flex items-center gap-3">
        <SignerAvatar signerKey={a.key} size={28} state={a.state} />
        <div className="flex flex-col">
          <span
            className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.1em" }}
          >
            {a.role}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {a.addr}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 text-right">
        {a.state === "signed" ? (
          <>
            <span
              className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.1em" }}
            >
              ✓ Signed
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {a.at}
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {a.sig}
            </span>
          </>
        ) : a.state === "pending" ? (
          <>
            <span
              className="inline-flex items-center gap-1.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-warn)]"
              style={{ letterSpacing: "0.1em" }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-warn)] [animation:pulse_1.4s_infinite]" />
              … Pending
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              awaiting signature
            </span>
          </>
        ) : (
          <>
            <span
              className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[#8c2a17]"
              style={{ letterSpacing: "0.1em" }}
            >
              ✕ Declined
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {a.at}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
