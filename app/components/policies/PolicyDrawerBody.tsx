"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { DrawerSection } from "@/components/shell/DetailDrawer";
import { SignerAvatar } from "./SignerAvatar";
import { SIGNERS } from "./signers";
import { SeverityPill, StatePill } from "./pills";
import { ApprovalChain } from "./ApprovalChain";
import { DiffView } from "./DiffView";
import { ProposeForm } from "./ProposeForm";
import { syntaxTint } from "./syntax-tint";
import type { Policy } from "./types";

export function PolicyDrawerBody({ policy, live }: { policy: Policy; live?: boolean }) {
  const [mode, setMode] = useState<"detail" | "propose">("detail");
  const [selectedRev, setSelectedRev] = useState(policy.revision);
  const [diffOpen, setDiffOpen] = useState(false);

  useEffect(() => {
    setMode("detail");
    setSelectedRev(policy.revision);
    setDiffOpen(false);
  }, [policy.id, policy.revision]);

  const activeRule = policy.rule[`v${policy.revision}`] ?? "";
  const selectedRule = policy.rule[`v${selectedRev}`] ?? "";
  const signedCount = policy.approvals.filter((a) => a.state === "signed").length;

  if (mode === "propose") {
    return (
      <ProposeForm
        policy={policy}
        live={live}
        onCancel={() => setMode("detail")}
        onSubmitted={() => setMode("detail")}
      />
    );
  }

  return (
    <>
      <DrawerSection title="Scope">
        <div className="grid gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-3">
          <ScopeRow label="Gates" value={policy.gates} />
          <ScopeRow
            label="Rooms"
            value={
              <span className="font-[family-name:var(--font-mono)] text-[12px]">
                {policy.rooms.join("  ·  ")}
              </span>
            }
          />
          <ScopeRow
            label="Verifier handler"
            value={
              <span
                className="font-[family-name:var(--font-mono)] text-[12px]"
                style={{ letterSpacing: 0 }}
              >
                {policy.handler}
              </span>
            }
          />
        </div>
      </DrawerSection>

      <DrawerSection
        title={`Current rule · v${policy.revision} · active`}
      >
        <pre
          className="m-0 overflow-x-auto rounded-[8px] bg-[#131715] py-3 text-[11.5px] leading-[1.55]"
          style={{ letterSpacing: 0 }}
        >
          {activeRule.split("\n").map((line, i) => (
            <div
              key={i}
              className="grid grid-cols-[44px_1fr] font-[family-name:var(--font-mono)]"
            >
              <span className="select-none px-2 text-right text-[#6c7a72]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="pr-3 text-[#e8e5dc] whitespace-pre">{syntaxTint(line)}</span>
            </div>
          ))}
        </pre>
      </DrawerSection>

      <DrawerSection
        title={`Approval chain · v${policy.revision} · ${signedCount}/${policy.signersTotal} signed`}
      >
        <ApprovalChain approvals={policy.approvals} />
      </DrawerSection>

      <DrawerSection title={`Revision history · ${policy.history.length} revisions`}>
        <ol className="m-0 flex flex-col gap-2 p-0">
          {policy.history.map((h) => {
            const isSelected = h.rev === selectedRev;
            const isActive = h.rev === policy.revision;
            const author = SIGNERS[h.author];
            return (
              <li
                key={h.rev}
                className={cn(
                  "grid items-start gap-2.5 rounded-[8px] border px-3 py-2.5",
                  isActive &&
                    "border-[color:rgba(30,102,66,0.28)] bg-[color:rgba(30,102,66,0.05)]",
                  !isActive &&
                    isSelected &&
                    "border-[color:rgba(30,102,66,0.18)] bg-[var(--avy-paper-solid)]",
                  !isActive && !isSelected && "border-[var(--avy-line)] bg-[var(--avy-paper-solid)]"
                )}
                style={{ gridTemplateColumns: "8px 1fr" }}
              >
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 rounded-full",
                    isActive ? "bg-[var(--avy-accent)]" : "bg-[var(--avy-line-strong)]"
                  )}
                />
                <div className="flex flex-col gap-1">
                  <div
                    className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px]"
                    style={{ letterSpacing: 0 }}
                  >
                    <span className="font-semibold text-[var(--avy-ink)]">v{h.rev}</span>
                    {isActive ? (
                      <span
                        className="rounded-full bg-[var(--avy-accent-soft)] px-1.5 py-px font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-accent)]"
                        style={{ letterSpacing: "0.1em" }}
                      >
                        active
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1">
                      <SignerAvatar signerKey={h.author} size={16} />
                      <span className="text-[var(--avy-muted)]">
                        {author?.addr.slice(0, 6)}…
                      </span>
                    </span>
                    <span className="text-[var(--avy-muted)]">{h.at}</span>
                  </div>
                  <div
                    className="text-[13px] leading-snug text-[var(--avy-ink)]"
                    style={{ letterSpacing: 0 }}
                  >
                    {h.summary}
                  </div>
                  {h.rev !== policy.revision ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRev(h.rev);
                        setDiffOpen(true);
                      }}
                      className="mt-1 inline-flex w-fit items-center gap-1 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-accent)] transition-colors hover:text-[var(--avy-accent-2)]"
                      style={{ letterSpacing: "0.06em" }}
                    >
                      view diff →
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </DrawerSection>

      {diffOpen && selectedRev !== policy.revision && selectedRule ? (
        <DrawerSection title={`Diff · v${selectedRev} → v${policy.revision}`}>
          <DiffView
            prev={selectedRule}
            next={activeRule}
            prevLabel={`v${selectedRev}`}
            nextLabel={`v${policy.revision} (active)`}
          />
          <button
            type="button"
            onClick={() => setDiffOpen(false)}
            className="self-start font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-muted)] hover:text-[var(--avy-ink)]"
            style={{ letterSpacing: "0.08em" }}
          >
            close diff
          </button>
        </DrawerSection>
      ) : null}

      <DrawerSection title={`Attached jobs · ${policy.attachedJobs.length} active · /runs`}>
        {policy.attachedJobs.length === 0 ? (
          <p
            className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            No active jobs currently guarded by this policy.
          </p>
        ) : (
          <ul className="m-0 flex flex-col gap-1 p-0">
            {policy.attachedJobs.map((j) => (
              <li
                key={j.id}
                className="grid items-center gap-3 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2"
                style={{ gridTemplateColumns: "110px 1fr auto auto" }}
              >
                <span
                  className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-accent)]"
                  style={{ letterSpacing: 0 }}
                >
                  {j.id}
                </span>
                <span
                  className="text-[13px] text-[var(--avy-ink)]"
                  style={{ letterSpacing: 0 }}
                >
                  {j.title}
                </span>
                <span
                  className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  {j.at}
                </span>
                <span
                  className="font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-accent)]"
                  style={{ letterSpacing: "0.06em" }}
                >
                  /runs →
                </span>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      {policy.state !== "Retired" ? (
        <div className="mt-1 flex flex-col gap-1.5 rounded-[10px] border border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.05)] p-3.5">
          <button
            type="button"
            onClick={() => setMode("propose")}
            className="inline-flex h-10 items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-4 font-[family-name:var(--font-display)] text-[12px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
            style={{ letterSpacing: "0.04em" }}
          >
            ＋ Propose change
          </button>
          <span
            className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            Drafts a <span className="text-[var(--avy-ink)]">v{policy.revision + 1}</span>{" "}
            revision and opens the approval chain. No instant apply.
          </span>
        </div>
      ) : null}
    </>
  );
}

function ScopeRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-baseline gap-2">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </span>
      <span className="text-[13px] text-[var(--avy-ink)]" style={{ letterSpacing: 0 }}>
        {value}
      </span>
    </div>
  );
}

export function PolicyDrawerHeader({ policy }: { policy: Policy }) {
  return (
    <>
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.14em" }}
      >
        Policy
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span
          className="font-[family-name:var(--font-mono)] text-[15px] font-semibold text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {policy.tag}
        </span>
        <SeverityPill severity={policy.severity} />
        <span
          className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          rev {policy.revision}
        </span>
        <StatePill state={policy.state} />
      </div>
    </>
  );
}
