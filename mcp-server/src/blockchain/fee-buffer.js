import { FeeData } from "ethers";

// Gas-fee headroom for Polkadot Hub transactions.
//
// Polkadot Hub meters weight (ref_time + proof_size) and prices it through a
// per-block "fee multiplier" (EIP-1559-style base fee) that can rise between the
// moment the eth-rpc adapter reports fee data and the moment our KMS-signed tx is
// actually broadcast + included. That latency window can leave a tx underpriced
// and stuck. We raise the fee CEILING fields by a small buffer so the tx still
// lands. This only ever RAISES a ceiling — the sender still pays the real base
// fee up to the cap — so it cannot cause an underpayment; it's pure robustness.
// (Gas LIMIT is left to ethers' estimate, which on Polkadot Hub is already
// conservative because it can't split computation weight from storage deposit.)

/**
 * Return a copy of `feeData` with its gasPrice / maxFeePerGas /
 * maxPriorityFeePerGas raised by `bufferBps` basis points. Null fields (e.g. a
 * legacy-only or 1559-only chain) are preserved as null. A non-positive buffer
 * returns the input unchanged.
 */
export function bufferFeeData(feeData, bufferBps) {
  const bps = Number.isFinite(bufferBps) ? Math.trunc(bufferBps) : 0;
  if (!feeData || bps <= 0) {
    return feeData;
  }
  const scale = (value) =>
    value === null || value === undefined ? value : (BigInt(value) * BigInt(10_000 + bps)) / 10_000n;
  return new FeeData(scale(feeData.gasPrice), scale(feeData.maxFeePerGas), scale(feeData.maxPriorityFeePerGas));
}

/**
 * Patch `provider.getFeeData` in place so every fee lookup (and therefore every
 * auto-populated tx) carries the buffer. No-op when the buffer is non-positive or
 * the provider lacks getFeeData (e.g. a disabled gateway).
 */
export function applyGasFeeBuffer(provider, bufferBps, logger = undefined) {
  const bps = Number.isFinite(bufferBps) ? Math.trunc(bufferBps) : 0;
  if (!provider || typeof provider.getFeeData !== "function" || bps <= 0) {
    return provider;
  }
  const original = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => bufferFeeData(await original(), bps);
  logger?.info?.({ bufferBps: bps }, "gateway.gas_fee_buffer_applied");
  return provider;
}
