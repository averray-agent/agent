import { cn } from "@/lib/utils/cn";
import { SIGNERS } from "./signers";
import type { Approval, ApprovalState, SignerKey } from "./types";

export interface SignerAvatarProps {
  signerKey: SignerKey;
  size?: number;
  state?: ApprovalState;
  className?: string;
}

/**
 * Hue-based avatar from the handoff. Each signer has a deterministic
 * hue, shown as an oklch chip with initials. The ring changes color
 * based on approval state — sage = signed, amber = pending,
 * neutral = unsigned.
 */
export function SignerAvatar({
  signerKey,
  size = 22,
  state,
  className,
}: SignerAvatarProps) {
  const s = SIGNERS[signerKey];
  if (!s) return null;
  const ring =
    state === "pending"
      ? "rgba(167,97,34,0.55)"
      : state === "signed"
        ? "rgba(30,102,66,0.55)"
        : state === "declined"
          ? "rgba(140,42,23,0.55)"
          : "rgba(17,19,21,0.18)";
  return (
    <span
      className={cn(
        "inline-grid place-items-center rounded-full font-[family-name:var(--font-mono)] font-semibold text-white",
        className
      )}
      title={`${s.role} · ${s.addr}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.floor(size / 2.4)),
        background: `oklch(78% 0.08 ${s.hue})`,
        boxShadow: `0 0 0 1.5px ${ring}, inset 0 0 0 1px rgba(255,255,255,0.4)`,
        letterSpacing: 0,
      }}
    >
      {s.initials}
    </span>
  );
}

export function SignerAvatarRow({
  signerKeys,
  approvals,
  size = 22,
}: {
  signerKeys: SignerKey[];
  approvals?: Approval[];
  size?: number;
}) {
  const byKey = new Map<SignerKey, ApprovalState>();
  approvals?.forEach((a) => byKey.set(a.key, a.state));
  return (
    <span className="inline-flex -space-x-2">
      {signerKeys.map((k) => (
        <SignerAvatar key={k} signerKey={k} size={size} state={byKey.get(k)} />
      ))}
    </span>
  );
}
