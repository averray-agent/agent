import { activeChain, explorerUrl, shortenAnchor } from "@/lib/chain/explorer";

type AnchorKind = "tx" | "block" | "address";

interface ExplorerLinkProps {
  /** What the value represents on chain. */
  kind: AnchorKind;
  /** A genuine on-chain anchor. Provenance matters: never pass a
   *  `chainJobId` (it is `0x`+64 hex like a tx hash but does not resolve
   *  on any explorer). */
  value: string | number;
  /** Visible text; defaults to a shortened form of `value`. */
  label?: string;
  /** Tailwind classes for the rendered element. */
  className?: string;
  /** Append the " ↗" external-link glyph (default true). */
  showGlyph?: boolean;
}

const KIND_NOUN: Record<AnchorKind, string> = {
  tx: "transaction",
  block: "block",
  address: "address",
};

/**
 * Renders a small "view on chain explorer" link for a chain-anchored
 * value, pointed at the environment-appropriate explorer
 * (`NEXT_PUBLIC_CHAIN_ENV`).
 *
 * Truth-boundary contract: if the active chain is unknown, or the value
 * is not a resolvable anchor for its `kind`, this renders the value as
 * plain text — never a link that would 404. So a misrouted value
 * degrades gracefully instead of pretending to be on-chain.
 */
export function ExplorerLink({
  kind,
  value,
  label,
  className,
  showGlyph = true,
}: ExplorerLinkProps) {
  const chain = activeChain();
  const url = chain ? explorerUrl(kind, chain.key, value) : null;
  const display = label ?? shortenAnchor(value);

  if (!url || !chain) {
    return (
      <span
        className={className}
        title={String(value)}
        data-explorer-link="unresolved"
      >
        {display}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={String(value)}
      aria-label={`View ${KIND_NOUN[kind]} ${value} on ${chain.label} block explorer`}
      className={
        className ??
        "font-semibold text-[var(--avy-accent)] hover:underline"
      }
      data-explorer-link="resolved"
    >
      {display}
      {showGlyph ? " ↗" : ""}
    </a>
  );
}
