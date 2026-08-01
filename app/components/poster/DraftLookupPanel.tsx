"use client";

import { useState } from "react";
import { useExternalDraft } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import { buildDraftView } from "@/lib/api/poster-adapters";
import { cn } from "@/lib/utils/cn";

const DRAFT_ID_RE = /^0x[0-9a-f]{64}$/iu;

/**
 * Honest lookup-by-id: there is no draft-list endpoint (drafts are
 * poster-owned server-side records reachable only by id), so the lens asks
 * for the id the posting tool printed instead of pretending to enumerate.
 */
export function DraftLookupPanel() {
  const [input, setInput] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const request = useExternalDraft(lookupId);
  const invalid = input.trim() !== "" && !DRAFT_ID_RE.test(input.trim());
  const view = request.data ? buildDraftView(request.data) : null;
  const status = request.error instanceof ApiError ? request.error.status : null;

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = input.trim();
          if (DRAFT_ID_RE.test(trimmed)) setLookupId(trimmed.toLowerCase());
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="0x… draft id (printed by the posting tool)"
          spellCheck={false}
          className="min-w-[320px] flex-1 rounded-[8px] border border-[var(--avy-line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] outline-none focus:border-[var(--avy-accent)]"
        />
        <button
          type="submit"
          disabled={!DRAFT_ID_RE.test(input.trim())}
          className={cn(
            "rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase",
            DRAFT_ID_RE.test(input.trim())
              ? "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
              : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
          )}
          style={{ letterSpacing: "0.1em" }}
        >
          Look up
        </button>
      </form>

      {invalid ? (
        <p className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-warn)]">
          A draft id is 0x followed by 64 hex characters.
        </p>
      ) : null}

      {lookupId && request.isLoading ? (
        <p className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]">
          Looking up draft…
        </p>
      ) : null}

      {status === 401 || status === 403 ? (
        <p className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-ink)]">
          Drafts are visible only to the poster wallet that created them —
          sign in with that wallet to view this draft.
        </p>
      ) : status === 404 ? (
        <p className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-ink)]">
          No draft with that id (drafts expire after their TTL).
        </p>
      ) : status !== null ? (
        <p className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-warn)]">
          Draft lookup failed (HTTP {status}).
        </p>
      ) : null}

      {view ? (
        <div className="flex flex-col gap-1.5">
          <span
            className="self-start rounded-full border border-[var(--avy-line)] bg-[#faf8f1] px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-ink)]"
            style={{ letterSpacing: "0.1em" }}
          >
            status · {view.status}
          </span>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {view.fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.1em" }}>
                  {field.label}
                </dt>
                <dd
                  className={cn(
                    "break-all text-[12px] text-[var(--avy-ink)]",
                    field.mono && "font-[family-name:var(--font-mono)]"
                  )}
                >
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
