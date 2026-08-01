"use client";

/**
 * The T8 honesty banner: states the live posting mode from
 * `GET /poster/onboarding` — never a dead "post" affordance, never a
 * hardcoded mode. When the payload is unavailable it says so instead of
 * guessing.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function PosterModeBanner({
  onboarding,
  unavailable,
}: {
  onboarding: unknown;
  unavailable: boolean;
}) {
  const payload = asRecord(onboarding);
  const mode = text(payload.mode);
  const economics = asRecord(payload.economics);
  const cancellation = asRecord(payload.cancellation);
  const docs = asRecord(payload.docs);
  const enrollment =
    text(payload.allowlistEnrollment) ??
    "Posting requires operator enrollment while the door is allowlist-only.";
  const feeBps = asRecord(economics.protocolFeeBps);
  const feeValue =
    typeof feeBps.value === "number"
      ? feeBps.value
      : typeof economics.protocolFeeBps === "number"
        ? economics.protocolFeeBps
        : null;
  const rescue = text(cancellation.rescue);
  const guideUrl = text(docs.guide);

  if (unavailable) {
    return (
      <div className="rounded-[10px] border border-[var(--avy-warn)] bg-[var(--avy-warn-soft)] px-4 py-3 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)]">
        Posting configuration is unavailable right now — the live mode and
        economics cannot be shown. This page stays read-only.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full border border-[var(--avy-line)] bg-[#faf8f1] px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-ink)]"
          style={{ letterSpacing: "0.1em" }}
        >
          {mode ? `Mode · ${mode}` : "Mode · unknown"}
        </span>
        {feeValue !== null ? (
          <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
            protocol fee {feeValue} bps, poster-additive — the worker receives
            the full reward
          </span>
        ) : null}
      </div>
      <p className="font-[family-name:var(--font-body)] text-[13px] leading-relaxed text-[var(--avy-ink)]">
        {enrollment} Enrolled wallets can post below — the draft is created
        first (no funds move), then your connected wallet signs the funding
        transactions the platform itself issues. Non-enrolled drafts are
        refused at submission; that refusal is the enrollment truth
        {guideUrl ? (
          <>
            {" "}
            (
            <a
              href={guideUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[var(--avy-accent)] hover:underline"
            >
              poster guide
            </a>
            )
          </>
        ) : null}
        .
      </p>
      {rescue ? (
        <p className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-muted)]">
          No self-serve cancel exists on-chain; stuck funds: {rescue}.
        </p>
      ) : null}
    </div>
  );
}
