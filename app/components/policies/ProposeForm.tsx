"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { SIGNERS } from "./signers";
import { SignerAvatar } from "./SignerAvatar";
import type { Policy, SignerKey } from "./types";

export function ProposeForm({
  policy,
  onCancel,
}: {
  policy: Policy;
  onCancel: () => void;
}) {
  const activeRule = policy.rule[`v${policy.revision}`] ?? "";
  const [body, setBody] = useState(activeRule);
  const [summary, setSummary] = useState("");
  const [selectedSigners, setSelectedSigners] = useState<SignerKey[]>([]);
  const [effDate, setEffDate] = useState("2026-05-01");

  const toggle = (k: SignerKey) =>
    setSelectedSigners((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  const enough = selectedSigners.length >= policy.signersReq && summary.trim().length > 3;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Propose change
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          Next revision →{" "}
          <span className="text-[var(--avy-ink)]">v{policy.revision + 1}</span> · requires{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {policy.signersReq} of {policy.signersTotal}
          </b>{" "}
          signers
        </span>
      </header>

      <Field label="Proposed rule body">
        <textarea
          spellCheck={false}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[220px] w-full resize-y rounded-[8px] border border-[var(--avy-line)] bg-[#131715] p-3 font-[family-name:var(--font-mono)] text-[12px] leading-[1.55] text-[#e8e5dc] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)]"
          style={{ letterSpacing: 0 }}
        />
        <span
          className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          bounded DSL · schema-validated by {policy.handler.split("/").pop()}
        </span>
      </Field>

      <Field label="Change summary">
        <input
          type="text"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="One line — what changed and why."
          className="h-9 w-full rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)]"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
        <Field label="Signers">
          <div className="flex flex-col gap-1.5">
            {policy.signerKeys.map((k) => {
              const s = SIGNERS[k];
              const on = selectedSigners.includes(k);
              return (
                <label
                  key={k}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-[8px] border px-3 py-2 transition-colors",
                    on
                      ? "border-[color:rgba(30,102,66,0.35)] bg-[color:rgba(30,102,66,0.06)]"
                      : "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] hover:border-[color:rgba(30,102,66,0.24)]"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(k)}
                    className="h-4 w-4 accent-[var(--avy-accent)]"
                  />
                  <SignerAvatar signerKey={k} size={20} state={on ? "signed" : undefined} />
                  <span
                    className="min-w-[140px] font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
                    style={{ letterSpacing: "0.1em" }}
                  >
                    {s.role}
                  </span>
                  <span
                    className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
                    style={{ letterSpacing: 0 }}
                  >
                    {s.addr}
                  </span>
                </label>
              );
            })}
          </div>
        </Field>

        <Field label="Effective date">
          <input
            type="date"
            value={effDate}
            onChange={(e) => setEffDate(e.target.value)}
            className="h-9 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.22)]"
            style={{ letterSpacing: 0 }}
          />
        </Field>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--avy-line-soft)] pt-3">
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {selectedSigners.length} of {policy.signersReq} required signers selected
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.24)]"
            style={{ letterSpacing: "0.04em" }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!enough}
            title={enough ? "" : "Select enough signers and write a summary"}
            className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
            style={{ letterSpacing: "0.04em" }}
          >
            Sign &amp; propose
          </button>
        </div>
      </footer>

      <p
        className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] p-3 font-[family-name:var(--font-body)] text-[12px] leading-[1.55] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        A proposal becomes active only after every required signer attests. This UI does
        not apply rules directly — it queues a revision for the approval chain.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
