export const WALLET_SESSION_INDEX_REPAIR_SCOPE = "wallet-session-index-repair-v1";

/**
 * One-shot repair for the historical case-sensitive wallet-session indexes.
 * New state-store writes are normalized, so a completed v1 sweep never needs
 * to be repeated. The versioned service-state marker makes restarts cheap and
 * preserves the measured repair counts for operator evidence.
 */
export async function repairWalletSessionIndex({
  stateStore,
  logger = console,
  now = () => new Date()
} = {}) {
  if (typeof stateStore?.reconcileWalletSessionIndex !== "function") {
    throw new TypeError("Wallet-session index repair requires a reconciling state store.");
  }
  const prior = await stateStore.getServiceState?.(WALLET_SESSION_INDEX_REPAIR_SCOPE);
  if (prior?.completed === true) {
    const result = { ...(prior.result ?? {}), skipped: true };
    logger.info?.(result, "wallet_session_index_repair.already_complete");
    return result;
  }

  const result = await stateStore.reconcileWalletSessionIndex();
  const completedAt = asIso(now());
  await stateStore.upsertServiceState?.(WALLET_SESSION_INDEX_REPAIR_SCOPE, {
    version: 1,
    completed: true,
    completedAt,
    result
  });
  const completed = { ...result, completedAt, skipped: false };
  logger.info?.(completed, "wallet_session_index_repair.completed");
  return completed;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Wallet-session index repair clock must be valid.");
  return date.toISOString();
}
