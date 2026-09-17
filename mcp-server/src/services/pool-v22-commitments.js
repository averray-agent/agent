import { Contract, getAddress } from "ethers";

export const POOL_V22_ABI = Object.freeze([
  "function commitment(address) view returns (uint8 tier, uint64 committedUntil)",
  "function deployableFor(uint256) view returns (uint256)",
  "function committedSharesBeyond(uint256) view returns (uint256)",
  "function committedSharesByTier() view returns (uint256[3])",
  "function convertToAssets(uint256) view returns (uint256)",
  "function bufferFloor() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function redeemRequests(uint256) view returns (address owner, address receiver, uint256 shares, uint64 unlockAt, uint8 tier, bool fulfilled)"
]);
export const POOL_V22_NAV_DISCLOSURE =
  "One NAV: venue gains and losses are shared pro-rata by all pool shares, including Flex. Commitments buy deployability and the existing off-chain perks, not separate yield entitlements.";
export const POOL_V22_SHARED_DISCLOSURE =
  "The aggregator uses the earliest consent expiry of its co-depositors. A T90 depositor sharing with T30 gets at most the shorter window; a shorter newcomer is refused and stays idle in AAC. The first co-depositor-limited T90 allocation triggers review of isolated tranche holders.";
export const POOL_V22_MIGRATION_PENDING =
  "Ceremony C is pending. At migration the v2.1 deposit door will pause new deposits; holders may request withdrawal with 7-day notice and redeposit into v2.2 at their leisure. Outside holders in v2.1 and legacy v2 are never moved by Averray.";
export const POOL_V22_MIGRATION_READY =
  "The v2.2 door is configured after Ceremony C. The v2.1 deposit door is retired; its contract has no pause. Existing v2.1 positions remain visible and withdrawals are unchanged: holders may request withdrawal with 7-day notice and redeposit into v2.2 at their leisure. Outside holders in v2.1 and legacy v2 are never moved by Averray.";

export class PoolV22CommitmentReader {
  constructor(provider, poolAddress) {
    this.provider = provider;
    this.pool = new Contract(getAddress(poolAddress), POOL_V22_ABI, provider);
  }

  async read({ wallet, blockNumber, blockTimestamp }) {
    const tag = { blockTag: blockNumber };
    const [deployable, backing, tierShares, floor, holder] = await Promise.all([
      Promise.all([7, 30, 90].map((d) => this.pool.deployableFor(d * 86400, tag))),
      Promise.all([7, 30, 90].map((d) => this.pool.committedSharesBeyond(blockTimestamp + d * 86400, tag))),
      this.pool.committedSharesByTier(tag),
      this.pool.bufferFloor(tag),
      wallet ? this.pool.commitment(wallet, tag) : null
    ]);
    const assets = await Promise.all(tierShares.map((s) => this.pool.convertToAssets(s, tag)));
    return {
      status: "available",
      backingConvention: "conservative_weekly_earliest_expiry",
      deployable: Object.fromEntries([7, 30, 90].map((d, i) => [String(d), amount(deployable[i])])),
      committedSharesBeyond: Object.fromEntries([7, 30, 90].map((d, i) => [String(d), amount(backing[i])])),
      tiers: [7, 30, 90].map((days, i) => ({ days, shares: amount(tierShares[i]), assets: amount(assets[i]) })),
      bufferFloor: amount(floor),
      ...(holder ? { holder: { tier: Number(holder.tier), committedUntil: Number(holder.committedUntil) } } : {})
    };
  }
}

export function poolV22Config(env = {}) {
  const ceremonyComplete = env.POOL_V22_CEREMONY_COMPLETE === "1";
  const enabled = ceremonyComplete && env.POOL_V22_LOCKED_KEEPER_ENABLED === "1";
  const poolAddress = env.POOL_V22_ADDRESS ? getAddress(env.POOL_V22_ADDRESS) : null;
  const adapterAddress = env.POOL_V22_AGGREGATOR_ADDRESS ? getAddress(env.POOL_V22_AGGREGATOR_ADDRESS) : null;
  if (ceremonyComplete && (!poolAddress || !adapterAddress)) throw new Error("pool_v22_addresses_missing");
  return { ceremonyComplete, enabled, poolAddress, adapterAddress };
}

function amount(raw) { return { raw: String(raw), decimals: 6 }; }
