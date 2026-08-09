import { CdpSettlementAdapter, resolveCdpSettlementConfig } from "./cdp/settlement-adapter.js";

export function createConfiguredSettlementAdapter(env = process.env, options = {}) {
  return new CdpSettlementAdapter({
    ...options,
    config: resolveCdpSettlementConfig(env)
  });
}
