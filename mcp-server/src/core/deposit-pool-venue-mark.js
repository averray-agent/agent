import { ConfigError } from "./errors.js";

const ASSET_DECIMALS = 6;
const BPS_SCALE = 10_000n;

/**
 * Tolerance for the gap between what the pool sent to the venue and what the
 * pool's own venue adapter reports as landed, expressed in bps of NAV.
 */
export const DEFAULT_VENUE_MARK_TOLERANCE_BPS = 10;

/** Absolute floor so raw-unit dust never closes the deposit door. */
export const DEFAULT_VENUE_MARK_DUST_FLOOR_RAW = 1_000n;

export const VENUE_MARK_SOURCE = "venue_adapter_managed_assets";

const STATEMENTS = Object.freeze({
  not_deployed:
    "No pool capital is at the venue, so cost basis and venue value cannot diverge. The quoted share price is exact.",
  ok:
    "The pool's venue adapter reports a landed value within tolerance of the deployed cost basis. The quoted share price carries the venue leg at cost.",
  surplus:
    "The pool's venue adapter reports more landed value than the deployed cost basis. The quoted share price carries the venue leg at cost and therefore understates NAV: this venue gain is recognised only when assets return to the pool buffer.",
  shortfall_exceeds_tolerance:
    "The pool's venue adapter reports less landed value than the deployed cost basis by more than the configured tolerance. The quoted share price carries the venue leg at cost and therefore overstates NAV. Deposits are refused until the shortfall is written off on chain.",
  unreadable:
    "Pool capital is at the venue and its landed value could not be read. The quoted share price cannot be proven honest, so deposits are refused."
});

function amount(raw) {
  return { raw: BigInt(raw).toString(), decimals: ASSET_DECIMALS };
}

function requireRaw(value, field) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new ConfigError(`${field} must be a non-negative raw-unit integer.`, { field, value });
  }
  return BigInt(text);
}

function nonNegativeIntegerConfig(value, fallback, field) {
  const candidate = value === undefined || value === null || String(value).trim() === "" ? fallback : value;
  const number = Number(candidate);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ConfigError(`${field} must be a non-negative integer.`, { field, value: candidate });
  }
  return number;
}

export function loadDepositPoolVenueMarkConfig(env = process.env) {
  return {
    toleranceBps: nonNegativeIntegerConfig(
      env.DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS,
      DEFAULT_VENUE_MARK_TOLERANCE_BPS,
      "DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS"
    ),
    dustFloorRaw: requireRaw(
      env.DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW ?? DEFAULT_VENUE_MARK_DUST_FLOOR_RAW,
      "DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW"
    )
  };
}

/**
 * Classify the venue leg by comparing the pool's deployed cost basis against
 * the landed value its own venue adapter reports.
 *
 * Both inputs are Asset Hub reads inside the pool's existing trust domain:
 * `venuePrincipalCostBasis()` on the pool and `managedAssets(pool)` on the
 * immutable adapter the pool already calls when sizing a recall. This is a
 * marking check, not an oracle — nothing here can move the share price, and a
 * verdict is only ever a refusal to quote.
 *
 * Fail-closed law: while cost basis is positive, an unreadable mark is a
 * refusal, never an assumption of health. When cost basis is zero there is no
 * venue leg to mark and the check is inert.
 */
export function evaluateVenueMark({
  costBasisRaw,
  markedRaw = undefined,
  totalAssetsRaw,
  toleranceBps = DEFAULT_VENUE_MARK_TOLERANCE_BPS,
  dustFloorRaw = DEFAULT_VENUE_MARK_DUST_FLOOR_RAW,
  unreadableReason = undefined
} = {}) {
  const costBasis = requireRaw(costBasisRaw, "costBasisRaw");
  const totalAssets = requireRaw(totalAssetsRaw, "totalAssetsRaw");
  const bps = BigInt(nonNegativeIntegerConfig(toleranceBps, DEFAULT_VENUE_MARK_TOLERANCE_BPS, "toleranceBps"));
  const dustFloor = requireRaw(dustFloorRaw, "dustFloorRaw");

  const proportional = totalAssets * bps / BPS_SCALE;
  const tolerance = proportional > dustFloor ? proportional : dustFloor;

  const base = {
    source: VENUE_MARK_SOURCE,
    toleranceBps: Number(bps),
    tolerance: amount(tolerance),
    costBasis: amount(costBasis)
  };

  if (costBasis === 0n) {
    return {
      ...base,
      status: "not_deployed",
      depositsBlocked: false,
      marked: markedRaw === undefined || markedRaw === null ? null : amount(markedRaw),
      shortfall: amount(0),
      surplus: amount(0),
      statement: STATEMENTS.not_deployed
    };
  }

  if (markedRaw === undefined || markedRaw === null) {
    return {
      ...base,
      status: "unreadable",
      depositsBlocked: true,
      marked: null,
      shortfall: null,
      surplus: null,
      ...(unreadableReason ? { reason: unreadableReason } : {}),
      statement: STATEMENTS.unreadable
    };
  }

  const marked = requireRaw(markedRaw, "markedRaw");
  const shortfall = marked >= costBasis ? 0n : costBasis - marked;
  const surplus = marked > costBasis ? marked - costBasis : 0n;
  // Surplus is unrecognised venue gain: the price understates NAV and dilutes
  // existing holders in favour of new ones. That is the pool's documented
  // conservative recognition, so it is disclosed and never gated — gating it
  // would close the door in the pool's normal earning state.
  const status = shortfall > tolerance
    ? "shortfall_exceeds_tolerance"
    : (surplus > 0n ? "surplus" : "ok");

  return {
    ...base,
    status,
    depositsBlocked: status === "shortfall_exceeds_tolerance",
    marked: amount(marked),
    shortfall: amount(shortfall),
    surplus: amount(surplus),
    statement: STATEMENTS[status]
  };
}

/**
 * NAV and share price with the venue leg carried at the adapter's reported
 * landed value instead of cost basis. Reported alongside the quoted price so
 * every read shows both, never the flattering one alone.
 */
export function markedSharePrice({ bufferAssetsRaw, markedRaw, totalSupplyRaw, shareScale = 1_000_000n }) {
  if (markedRaw === undefined || markedRaw === null) return null;
  const buffer = requireRaw(bufferAssetsRaw, "bufferAssetsRaw");
  const marked = requireRaw(markedRaw, "markedRaw");
  const supply = requireRaw(totalSupplyRaw, "totalSupplyRaw");
  const navRaw = buffer + marked;
  return {
    model: "venue-marked-to-adapter",
    totalAssets: amount(navRaw),
    assetsPerShare: amount(supply === 0n ? shareScale : navRaw * shareScale / supply),
    numeratorAssetsRaw: navRaw.toString(),
    denominatorSharesRaw: supply.toString()
  };
}
