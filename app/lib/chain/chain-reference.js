/**
 * Provenance-aware classification of a chain-anchored reference.
 *
 * An escrow `chainJobId` is the bytes32 key EscrowCore uses for a job. It is
 * SHAPE-IDENTICAL to an EVM transaction hash (`0x` + 64 hex) but it is NOT a
 * transaction and does NOT resolve on any block explorer. We therefore decide
 * what a value *is* by its PROVENANCE — which backend field it came from —
 * never by its shape:
 *
 *   - a value from a genuine transaction field (`txHash` / timeline `data.tx`)
 *     is a transaction, and only then *if* it also validates as `0x` + 64 hex;
 *   - a `chainJobId` is always an escrow job id, never a transaction, even
 *     though it matches the same regex.
 *
 * Consumers use `kind` to label honestly ("Escrow job" vs a transaction) and
 * to gate any chain-explorer link: only a `kind === "tx"` reference may ever
 * link out (see `isLinkableChainReference`). This keeps the surface from
 * making an internal escrow id look more on-chain than it is.
 *
 * @typedef {"tx" | "job" | "none"} ChainRefKind
 * @typedef {{ kind: ChainRefKind, value: string }} ChainRef
 */

/** Canonical EVM transaction-hash shape: `0x` followed by 64 hex digits. */
export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

/**
 * True only for a value that is a genuine transaction-hash *shape*. Shape is
 * necessary but NOT sufficient to call something a transaction — the caller
 * must also have read it from a real tx field (see `classifyChainReference`),
 * because a `chainJobId` passes this same check.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTxHash(value) {
  return typeof value === "string" && TX_HASH_PATTERN.test(value.trim());
}

/**
 * Classify a chain reference from its candidate sources, by provenance.
 *
 * `txHash` is honored only when it validates as a real tx hash; otherwise we
 * fall back to the escrow `jobId`, which is presented as a job id and is never
 * linkable. A `jobId` is taken verbatim regardless of shape: it is a job key,
 * not a transaction, even when it looks like one.
 *
 * @param {{ txHash?: unknown, jobId?: unknown }} [input]
 * @returns {ChainRef}
 */
export function classifyChainReference({ txHash, jobId } = {}) {
  if (isTxHash(txHash)) {
    return { kind: "tx", value: /** @type {string} */ (txHash).trim() };
  }
  const job = typeof jobId === "string" ? jobId.trim() : "";
  if (job) return { kind: "job", value: job };
  return { kind: "none", value: "" };
}

/**
 * Whether a reference may be linked to a block explorer. Only genuine
 * transactions resolve on an explorer — an escrow job id must never be linked.
 * This is the gate the C1 explorer-link work consumes.
 *
 * @param {ChainRef} ref
 * @returns {boolean}
 */
export function isLinkableChainReference(ref) {
  return Boolean(ref) && ref.kind === "tx";
}

/**
 * Honest, human-readable description of a reference, used for the cell title
 * so an auditor never reads an escrow job id as an on-chain transaction.
 *
 * @param {ChainRef} ref
 * @returns {string}
 */
export function chainReferenceTitle(ref) {
  if (!ref || ref.kind === "none") return "No on-chain reference yet";
  if (ref.kind === "tx") return `On-chain transaction ${ref.value}`;
  return `Escrow job id ${ref.value} — internal EscrowCore key, not an on-chain transaction`;
}
