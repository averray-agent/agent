const REQUEST_ID_RE = /^0x[a-fA-F0-9]{64}$/u;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/u;

/**
 * Select the latest current-generation deposit whose swap output is backed by
 * either a remote Hydration event or the dispatch-time dry run. Callers that
 * need an immutable chain read must additionally require remoteBlockNumber.
 */
export function findLatestDepositSwap(events, configuredWrapper) {
  for (const event of [...(events ?? [])].reverse()) {
    const evidence = event?.data ?? {};
    if (evidence.leg !== "deposit_sell" || !sameAddress(evidence.wrapper, configuredWrapper)) continue;
    const remoteSwap = evidence.remoteExecution?.event;
    const candidates = [
      ...(remoteSwap ? [{ ...remoteSwap, evidenceKind: "remote_execution" }] : []),
      ...(evidence.dryRun?.events ?? []).map((candidate) => ({ ...candidate, evidenceKind: "dry_run" }))
    ];
    const swap = candidates.find((candidate) =>
      String(candidate?.section ?? "").toLowerCase() === "broadcast"
      && ["swapped", "swapped3"].includes(String(candidate?.method ?? "").toLowerCase())
      && String(candidate?.data?.fillerType ?? "").toUpperCase() === "AAVE"
      && Number(candidate?.data?.assetIn) === 22
      && Number(candidate?.data?.assetOut) === 1003
    );
    const output = swap?.data?.outputs?.find((entry) => parseUnsignedRaw(entry?.asset) === 1003n);
    const raw = parseUnsignedRaw(output?.amount);
    const requestId = String(evidence.requestId ?? event.correlationId ?? "").toLowerCase();
    const txHash = String(evidence.txHash ?? event.txHash ?? "");
    const blockNumber = Number(evidence.blockNumber ?? event.blockNumber);
    if (
      raw === null
      || raw <= 0n
      || !REQUEST_ID_RE.test(requestId)
      || !TX_HASH_RE.test(txHash)
      || !Number.isSafeInteger(blockNumber)
      || blockNumber <= 0
    ) continue;
    const remote = swap.evidenceKind === "remote_execution" ? evidence.remoteExecution : undefined;
    const remoteBlockNumber = Number(remote?.blockNumber);
    return {
      raw,
      requestId,
      wrapperAddress: String(evidence.wrapper).toLowerCase(),
      txHash,
      blockNumber,
      remoteBlockNumber: Number.isSafeInteger(remoteBlockNumber) && remoteBlockNumber > 0
        ? remoteBlockNumber
        : null,
      timestamp: event.timestamp ?? evidence.capturedAt ?? "unknown",
      eventSource: remote
        ? "Hydration system.events Broadcast.Swapped3{AAVE, asset 22 -> aUSDC 1003}"
        : "exact-message dry-run Broadcast.Swapped{AAVE, asset 22 -> aUSDC 1003}",
      eventProof: remote
        ? `hydration block ${remote.blockNumber} ${remote.blockHash} event ${remote.eventIndex}`
        : "dispatch evidence exact-message dry-run"
    };
  }
  return null;
}

function parseUnsignedRaw(value) {
  const normalized = String(value ?? "").replaceAll(",", "");
  return /^(0|[1-9][0-9]*)$/u.test(normalized) ? BigInt(normalized) : null;
}

function sameAddress(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}
