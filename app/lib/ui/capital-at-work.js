// Pure decision for the "Capital at work" room vital.
//
// Capital at work sums the strategy allocation with locked job stake, so an
// unreadable strategy feed means the total is genuinely unavailable — not zero.
// On 2026-08-18 the tile rendered a confident green "0 USDC" while 5.0 USDC sat
// deployed at the venue: the feed was blind (#1121 — multisig writes are
// Substrate extrinsics, whose contract events never reach eth_getLogs), not
// empty. Absence of a reading is not a reading of absence.
//
// The sibling "Treasury posture" vital already refuses to state what it could
// not read; this keeps the two tiles telling the same story.

/**
 * @param {{ presence?: string, value?: string | number, unit?: string }} [input]
 * @returns {{ label: string, value: string | number, unit?: string, delta: string, deltaTone: "good" | "neutral" }}
 */
export function buildCapitalAtWorkVital({ presence, value, unit } = {}) {
  if (presence === "live") {
    return { label: "Capital at work", value, unit, delta: "strategy + stake", deltaTone: /** @type {const} */ ("good") };
  }
  return {
    label: "Capital at work",
    value: "—",
    delta:
      presence === "loading"
        ? "waiting for strategy feed"
        : "strategy feed unreachable — retrying — allocation not observable",
    deltaTone: /** @type {const} */ ("neutral")
  };
}
