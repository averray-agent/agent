import { cn } from "@/lib/utils/cn";

export type SignerTone = "sage" | "ink" | "clay" | "blue" | "muted";

export interface Signer {
  initials: string;
  tone: SignerTone;
  role: string;
  address: string;
}

const TONE: Record<SignerTone, string> = {
  sage: "bg-[var(--avy-accent)] text-[var(--fg-invert)]",
  ink: "bg-[var(--avy-dark)] text-[var(--fg-invert)]",
  clay: "bg-[#a76122] text-[var(--fg-invert)]",
  blue: "bg-[var(--avy-blue)] text-[var(--fg-invert)]",
  muted: "bg-[#8a8777] text-[var(--fg-invert)]",
};

export function SignerAvatars({
  signers,
  max = 3,
}: {
  signers: Signer[];
  max?: number;
}) {
  const shown = signers.slice(0, max);
  const extra = signers.length - shown.length;

  return (
    <span className="group relative inline-flex items-center gap-2">
      <span className="inline-flex">
        {shown.map((s, i) => (
          <span
            key={i}
            className={cn(
              "grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-[var(--avy-paper-solid)] font-[family-name:var(--font-mono)] text-[9.5px] font-semibold",
              TONE[s.tone],
              i > 0 && "-ml-[7px]"
            )}
            style={{ letterSpacing: 0 }}
            title={`${s.role} · ${s.address}`}
          >
            {s.initials}
          </span>
        ))}
        {extra > 0 ? (
          <span
            className="grid h-[22px] w-[22px] -ml-[7px] place-items-center rounded-full border-2 border-[var(--avy-paper-solid)] bg-[#ebe7da] font-[family-name:var(--font-mono)] text-[9px] text-[#756d58]"
            style={{ letterSpacing: 0 }}
          >
            +{extra}
          </span>
        ) : null}
      </span>

      {/* hover tooltip with full signer list */}
      <span className="pointer-events-none absolute left-0 top-full z-10 mt-1.5 hidden min-w-[220px] rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-2 shadow-[var(--shadow-card)] group-hover:block">
        {signers.map((s, i) => (
          <span
            key={i}
            className="flex items-center gap-2 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            <span
              className="min-w-[58px] font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.1em" }}
            >
              {s.role}
            </span>
            <span>{s.address}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
