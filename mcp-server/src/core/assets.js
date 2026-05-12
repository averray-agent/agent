export const DEFAULT_ESCROW_ASSET = {
  symbol: "USDC",
  assetClass: "trust_backed",
  assetId: 1337,
  address: "0x0000053900000000000000000000000001200000",
  decimals: 6,
  minBalanceRaw: "70000"
};

export const DEFAULT_ESCROW_ASSET_SYMBOL = DEFAULT_ESCROW_ASSET.symbol;
export const DEFAULT_ESCROW_ASSET_DECIMALS = DEFAULT_ESCROW_ASSET.decimals;

export const ASSET_DECIMALS_BY_SYMBOL = {
  DOT: 18,
  USDC: 6,
  USDT: 6,
  USDT0: 6,
  USDt: 6,
  VDOT: 10
};

export function normalizeAssetSymbol(value, fallback = DEFAULT_ESCROW_ASSET_SYMBOL) {
  const symbol = String(value ?? fallback).trim();
  return symbol ? symbol.toUpperCase() : fallback;
}

export function decimalsForAssetSymbol(symbol, fallback = DEFAULT_ESCROW_ASSET_DECIMALS) {
  const normalized = normalizeAssetSymbol(symbol);
  const decimals = ASSET_DECIMALS_BY_SYMBOL[normalized];
  return Number.isInteger(decimals) ? decimals : fallback;
}

export function knownAssetMinBalanceRaw(asset = {}) {
  if (
    asset.assetClass === DEFAULT_ESCROW_ASSET.assetClass
    && Number(asset.assetId) === DEFAULT_ESCROW_ASSET.assetId
    && normalizeAssetSymbol(asset.symbol) === DEFAULT_ESCROW_ASSET.symbol
  ) {
    return DEFAULT_ESCROW_ASSET.minBalanceRaw;
  }
  return undefined;
}
