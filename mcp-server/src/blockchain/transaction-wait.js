import { BlockchainRevertError, ExternalServiceError } from "../core/errors.js";
import { describeRpcProvider } from "./rpc-provider.js";

export const DEFAULT_BROKERED_TX_TIMEOUT_MS = 60_000;
// Recovery probes run in parallel, outside the wait budget, and cannot turn a
// bounded wait into another unbounded RPC call. This is not a retry/broadcast.
const PROBE_TIMEOUT_MS = 2_000;
const BLOCK_SILENCE_MS = 10_000;

export function brokeredTransactionTimeout(details) {
  return new ExternalServiceError(
    "Transaction confirmation is unavailable; inspect the recorded hash before retrying.",
    "brokered_tx_timeout",
    details
  );
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("receipt wait timeout"), { code: "TIMEOUT" })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function requireSuccessfulReceipt(receipt) {
  if (receipt && Number(receipt.status) === 0) {
    throw new BlockchainRevertError("Transaction execution reverted.", {
      txHash: receipt.hash ?? receipt.transactionHash, blockNumber: receipt.blockNumber
    });
  }
  return receipt;
}

/** Direct child-runner reads, never the FallbackProvider quorum. */
export async function probeTransactionReceipts(tx, runners, emit, phase) {
  return Promise.all(runners.map(async (runner) => {
    const runnerLabel = describeRpcProvider(runner);
    const probe = async (read, kind) => {
      try {
        const value = await bounded(Promise.resolve().then(read), PROBE_TIMEOUT_MS);
        emit("tx_wait_probe", {
          phase, runner: runnerLabel, kind,
          ...(kind === "receipt"
            ? { receipt: value ? "mined" : "null", blockNumber: value?.blockNumber ?? null, status: value?.status ?? null }
            : { latestNonce: value })
        });
        return { value, ok: true };
      } catch (error) {
        // Do not log provider messages, URLs with credentials, or signed bytes.
        emit("tx_wait_probe", { phase, runner: runnerLabel, kind, result: "error", code: error?.code ?? "RPC_ERROR" });
        return { value: null, ok: false };
      }
    };
    const [receipt, nonce] = await Promise.all([
      probe(() => runner.getTransactionReceipt(tx.hash), "receipt"),
      ...(phase === "recovery" && tx.from
        ? [probe(() => runner.getTransactionCount(tx.from, "latest"), "nonce")]
        : [])
    ]);
    return {
      receipt: receipt.value, receiptReadSucceeded: receipt.ok,
      latestNonce: nonce?.value ?? null, nonceReadSucceeded: nonce?.ok === true,
      runner: runnerLabel
    };
  }));
}

/**
 * The sole gateway receipt wait. Preserve revert/replacement errors; a timeout
 * is not evidence of failure on chain. Never sign or broadcast from this helper.
 */
export async function waitForTransaction(tx, {
  stage, jobId, logger, runners = [], timeoutMs = DEFAULT_BROKERED_TX_TIMEOUT_MS,
  persist = async () => {}
}) {
  const startedAt = Date.now();
  const fields = { stage, jobId: jobId ?? null, txHash: tx.hash ?? null, nonce: tx.nonce ?? null };
  const journalFields = { ...fields, from: tx.from ?? null, waitStartedAt: startedAt };
  const waitRunner = describeRpcProvider(tx.provider);
  const emit = (event, extra = {}) => logger?.info?.({ event, ...fields, runner: waitRunner, ms: Date.now() - startedAt, ...extra }, event);
  const directRunners = [...new Set(runners.length ? runners : tx.provider ? [tx.provider] : [])];
  let blockEvents = 0;
  let lastBlockAt = startedAt;
  let outcome = "failed";
  let receiptRunner = waitRunner;
  const onBlock = (blockNumber) => {
    blockEvents += 1;
    lastBlockAt = Date.now();
    emit("tx_wait_block", { blockNumber, blockEvents });
  };
  // Persist before waiting so a disconnect/restart cannot erase the broadcast.
  await persist({ ...journalFields, status: "pending" });
  const subscription = Promise.resolve().then(() => tx.provider?.on?.("block", onBlock));
  subscription.catch(() => {});
  const silence = setInterval(() => {
    if (Date.now() - lastBlockAt >= BLOCK_SILENCE_MS) {
      emit("tx_wait_block_silence", { blockEvents, silenceMs: Date.now() - lastBlockAt });
    }
  }, BLOCK_SILENCE_MS);
  silence.unref?.();
  try {
    emit("tx_wait_started");
    const immediate = await probeTransactionReceipts(tx, directRunners, emit, "immediate");
    const immediateReceipt = immediate.find((result) => result.receipt);
    let receipt = immediateReceipt?.receipt;
    if (immediateReceipt) receiptRunner = immediateReceipt.runner;
    if (!receipt) {
      try {
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        // Ethers starts its timer *after* the initial receipt/replacement reads.
        // The outer bound also covers those reads if a runner never answers.
        receipt = await bounded(tx.wait(1, remainingMs), remainingMs);
      } catch (error) {
        if (error?.code !== "TIMEOUT") throw error;
        emit("tx_wait_timeout", { blockEvents, silenceMs: Date.now() - lastBlockAt });
        const results = await probeTransactionReceipts(tx, directRunners, emit, "recovery");
        const recovered = results.find((result) => result.receipt);
        if (!recovered) {
          outcome = "timeout";
          await persist({ ...journalFields, status: "timeout" });
          throw brokeredTransactionTimeout(fields);
        }
        receipt = recovered.receipt;
        receiptRunner = recovered.runner;
        emit("tx_wait_recovered_by_reread", { runner: recovered.runner, blockNumber: receipt.blockNumber, status: receipt.status });
      }
    }
    requireSuccessfulReceipt(receipt);
    outcome = "confirmed";
    await persist({ ...journalFields, status: "confirmed", blockNumber: receipt?.blockNumber ?? null });
    return receipt;
  } catch (error) {
    if (error?.code !== "brokered_tx_timeout") {
      await persist({ ...journalFields, status: "failed", errorCode: error?.code ?? "WAIT_ERROR" });
    }
    throw error;
  } finally {
    clearInterval(silence);
    // Event registration is async in ethers. Clean up even if it completes late.
    void subscription.then(() => tx.provider?.off?.("block", onBlock)).catch(() => {});
    emit("tx_wait_completed", { outcome, runner: receiptRunner, blockEvents, silenceMs: Date.now() - lastBlockAt });
  }
}
