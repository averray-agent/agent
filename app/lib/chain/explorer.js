/**
 * Block-explorer link helpers for chain-anchored entities.
 *
 * Pure, side-effect-free URL builders so `node:test` can exercise them
 * without a browser or env. The React `<ExplorerLink>` wrapper
 * (`app/components/common/ExplorerLink.tsx`) reads the active chain from
 * `NEXT_PUBLIC_CHAIN_ENV` and calls these.
 *
 * Explorer base URLs are taken from the official Polkadot docs:
 *   - smart-contracts/explorers.md
 *   - smart-contracts/connect.md (network details / chain IDs)
 * verified via the polkadot-docs MCP on 2026-05-29.
 *
 * TRUTH-BOUNDARY NOTE: every builder returns `null` when it cannot
 * produce a link that will actually resolve — an unknown chain, or a
 * value whose *shape* is not a real tx hash / block / address. Callers
 * must only pass values whose *provenance* is a genuine on-chain
 * anchor. In particular a `chainJobId` is a bytes32 (`0x`+64 hex) that
 * is indistinguishable from a tx hash by shape but does NOT resolve on
 * any explorer — never feed one of those in.
 */

/**
 * @typedef {"paseo" | "polkadot" | "kusama"} ChainKey
 * @typedef {"subscan" | "blockscout"} ExplorerKind
 * @typedef {"tx" | "block" | "address"} AnchorKind
 *
 * @typedef {Object} ChainInfo
 * @property {ChainKey} key
 * @property {string} label        Human label for aria/title text.
 * @property {number} chainId      EVM chain id.
 * @property {boolean} isMainnet   True only for the production Polkadot Hub.
 * @property {string} subscanBase  Subscan origin (no trailing slash).
 * @property {string} blockscoutBase Blockscout origin (no trailing slash).
 */

/** @type {Record<ChainKey, ChainInfo>} */
export const CHAINS = {
  paseo: {
    key: "paseo",
    label: "Polkadot Hub TestNet (Paseo Asset Hub)",
    chainId: 420420417,
    isMainnet: false,
    subscanBase: "https://assethub-paseo.subscan.io",
    blockscoutBase: "https://blockscout-testnet.polkadot.io",
  },
  polkadot: {
    key: "polkadot",
    label: "Polkadot Hub (Asset Hub)",
    chainId: 420420419,
    isMainnet: true,
    subscanBase: "https://assethub-polkadot.subscan.io",
    blockscoutBase: "https://blockscout.polkadot.io",
  },
  kusama: {
    key: "kusama",
    label: "Kusama Hub (Asset Hub)",
    chainId: 420420418,
    isMainnet: false,
    subscanBase: "https://assethub-kusama.subscan.io",
    blockscoutBase: "https://blockscout-kusama.polkadot.io",
  },
};

/**
 * Default chain when `NEXT_PUBLIC_CHAIN_ENV` is unset. The deployment
 * currently runs on Paseo TestNet, so defaulting here keeps links
 * working out of the box. Production (mainnet) MUST set
 * `NEXT_PUBLIC_CHAIN_ENV=polkadot` — an *unknown* value fails closed
 * (no link) rather than guessing the wrong network.
 * @type {ChainKey}
 */
export const DEFAULT_CHAIN_KEY = "paseo";

/** @type {ExplorerKind} Default explorer brand for generated links. */
export const DEFAULT_EXPLORER = "subscan";

/**
 * Per-explorer path templates. Subscan and Blockscout differ on the
 * account/address segment, so they are modelled separately rather than
 * sharing one template.
 * @type {Record<ExplorerKind, { tx(h: string): string, block(b: string): string, address(a: string): string }>}
 */
const EXPLORER_PATHS = {
  subscan: {
    tx: (h) => `/tx/${h}`,
    block: (b) => `/block/${b}`,
    address: (a) => `/account/${a}`,
  },
  blockscout: {
    tx: (h) => `/tx/${h}`,
    block: (b) => `/block/${b}`,
    address: (a) => `/address/${a}`,
  },
};

/**
 * Resolve a chain key string (e.g. from env) to a known chain.
 * @param {unknown} key
 * @returns {ChainInfo | null}
 */
export function resolveChain(key) {
  if (typeof key !== "string") return null;
  const normalized = key.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CHAINS, normalized)
    ? CHAINS[/** @type {ChainKey} */ (normalized)]
    : null;
}

/**
 * The chain the app is currently pointed at, derived from
 * `NEXT_PUBLIC_CHAIN_ENV`. Unset → {@link DEFAULT_CHAIN_KEY} (Paseo).
 * Set-but-unknown → `null` (fail closed: callers render plain text, no
 * misleading link).
 * @returns {ChainInfo | null}
 */
export function activeChain() {
  const raw =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.NEXT_PUBLIC_CHAIN_ENV) ||
    "";
  const trimmed = String(raw).trim();
  if (!trimmed) return CHAINS[DEFAULT_CHAIN_KEY];
  return resolveChain(trimmed);
}

/**
 * True for a genuine EVM transaction hash (`0x` + 64 hex).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isTxHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

/**
 * True for a genuine EVM account/contract address (`0x` + 40 hex).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isEvmAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}

/**
 * True for a non-negative integer block number (accepts numeric string).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlockNumber(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
  return typeof value === "string" && /^\d+$/u.test(value.trim());
}

/**
 * @param {ChainInfo} chain
 * @param {ExplorerKind} explorer
 * @returns {string}
 */
function baseFor(chain, explorer) {
  return explorer === "blockscout" ? chain.blockscoutBase : chain.subscanBase;
}

/**
 * Build an explorer URL for a transaction hash.
 * @param {unknown} chainKey
 * @param {unknown} hash
 * @param {{ explorer?: ExplorerKind }} [opts]
 * @returns {string | null}
 */
export function explorerTxUrl(chainKey, hash, opts = {}) {
  const chain = resolveChain(chainKey);
  if (!chain || !isTxHash(hash)) return null;
  const explorer = opts.explorer ?? DEFAULT_EXPLORER;
  return `${baseFor(chain, explorer)}${EXPLORER_PATHS[explorer].tx(hash)}`;
}

/**
 * Build an explorer URL for a block number.
 * @param {unknown} chainKey
 * @param {unknown} block
 * @param {{ explorer?: ExplorerKind }} [opts]
 * @returns {string | null}
 */
export function explorerBlockUrl(chainKey, block, opts = {}) {
  const chain = resolveChain(chainKey);
  if (!chain || !isBlockNumber(block)) return null;
  const explorer = opts.explorer ?? DEFAULT_EXPLORER;
  const value = String(typeof block === "string" ? block.trim() : block);
  return `${baseFor(chain, explorer)}${EXPLORER_PATHS[explorer].block(value)}`;
}

/**
 * Build an explorer URL for an account/contract address.
 * @param {unknown} chainKey
 * @param {unknown} address
 * @param {{ explorer?: ExplorerKind }} [opts]
 * @returns {string | null}
 */
export function explorerAddressUrl(chainKey, address, opts = {}) {
  const chain = resolveChain(chainKey);
  if (!chain || !isEvmAddress(address)) return null;
  const explorer = opts.explorer ?? DEFAULT_EXPLORER;
  return `${baseFor(chain, explorer)}${EXPLORER_PATHS[explorer].address(address)}`;
}

/**
 * Convenience dispatcher used by the React wrapper.
 * @param {AnchorKind} kind
 * @param {unknown} chainKey
 * @param {unknown} value
 * @param {{ explorer?: ExplorerKind }} [opts]
 * @returns {string | null}
 */
export function explorerUrl(kind, chainKey, value, opts = {}) {
  switch (kind) {
    case "tx":
      return explorerTxUrl(chainKey, value, opts);
    case "block":
      return explorerBlockUrl(chainKey, value, opts);
    case "address":
      return explorerAddressUrl(chainKey, value, opts);
    default:
      return null;
  }
}

/**
 * Shorten a hash/address for display (`0x1234abcd…wxyz`). Block numbers
 * and short values pass through unchanged.
 * @param {string | number} value
 * @returns {string}
 */
export function shortenAnchor(value) {
  const str = String(value);
  if (!str.startsWith("0x") || str.length <= 14) return str;
  return `${str.slice(0, 10)}…${str.slice(-4)}`;
}
