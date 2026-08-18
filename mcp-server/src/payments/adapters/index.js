import {
  CdpPaymentFacilitator,
  CdpSettlementAdapter,
  resolveCdpSettlementConfig
} from "./cdp/settlement-adapter.js";

export function createConfiguredSettlementAdapter(env = process.env, options = {}) {
  return new CdpSettlementAdapter({
    ...options,
    config: resolveCdpSettlementConfig(env)
  });
}

export function createConfiguredPaymentFacilitator(env = process.env, options = {}) {
  return new CdpPaymentFacilitator({
    ...options,
    config: resolveCdpSettlementConfig(env)
  });
}
