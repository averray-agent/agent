import { Interface, encodeBytes32String, getAddress, toBeHex } from "ethers";
import { importCeremonyModule } from "./ceremony-module-loader.mjs";

const { XCM_WRAPPER_ABI, HYDRATION_USDC_ADAPTER_V22_ABI } = await importCeremonyModule({
  label: "recall unwind ABIs",
  candidates: [new URL("../../mcp-server/src/blockchain/abis.js", import.meta.url), "file:///app/src/blockchain/abis.js"],
});
const { waitForTransaction, DEFAULT_BROKERED_TX_TIMEOUT_MS } = await importCeremonyModule({
  label: "bounded recall unwind wait",
  candidates: [new URL("../../mcp-server/src/blockchain/transaction-wait.js", import.meta.url), "file:///app/src/blockchain/transaction-wait.js"],
});
const wrapperInterface = new Interface(XCM_WRAPPER_ABI);
const laneInterface = new Interface(HYDRATION_USDC_ADAPTER_V22_ABI);
export const MAX_RECALL_ATTEMPTS = 3;
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 180_000;
export const SELL_NOT_EXECUTED = encodeBytes32String("SELL_NOT_EXECUTED");
const ZERO32 = `0x${"00".repeat(32)}`;
const raw = (value) => BigInt(String(value).replaceAll(",", ""));
const hex32 = (value) => /^0x[0-9a-f]{64}$/iu.test(String(value));
const lower = (value) => String(value ?? "").toLowerCase();

export function assertNoRecallSlack(value = "0") {
  if (!/^\d+$/u.test(String(value)) || BigInt(value) !== 0n) {
    throw new Error("Nonzero --min-out-slack-raw is forbidden: HydrationDepositPoolAdapter.stageRecall requires minimumOutput == requestedAssets (v2.1 and v2.2).");
  }
}

// Count requests, not process-local retries. Abandon/settle remain available
// after the cap; only creating/staging another recall is forbidden. Counting
// all recalls of the deployment is deliberately conservative, including an
// unstaged cancellation. No CLI override silently starts another fee loop.
export async function assertRecallAttemptBudget(pool, deploymentId, { currentRecallId, blockTag } = {}) {
  const overrides = blockTag === undefined ? {} : { blockTag };
  const next = BigInt(await pool.nextVenueRecallId(overrides));
  if (next < 1n || next > 10_001n) throw new Error("Recall history is outside the bounded audit range; human review required.");
  const ids = [];
  let currentFound = currentRecallId === undefined;
  for (let id = 1n; id < next; id++) {
    const recall = await pool.venueRecalls(id, overrides);
    if (BigInt(recall.deploymentId) !== BigInt(deploymentId)) continue;
    ids.push(id);
    if (currentRecallId !== undefined && id === BigInt(currentRecallId)) currentFound = true;
  }
  if (!currentFound) throw new Error("Current recall is absent from its deployment's chain history.");
  const attempt = ids.length + (currentRecallId === undefined ? 1 : 0);
  if (attempt > MAX_RECALL_ATTEMPTS) throw new Error(`recall_retry_cap: deployment ${deploymentId} has exhausted ${MAX_RECALL_ATTEMPTS} recall attempts; stop for human review.`);
  return { attempt, maximum: MAX_RECALL_ATTEMPTS, priorRecallIds: ids, source: "pool.venueRecalls" };
}

export function collectRecallSellEvents(records, requestId, block, accountId32, api) {
  const swaps = [];
  const processed = [];
  const positionDebits = [];
  for (const record of records) {
    const event = record?.event;
    const data = event?.data;
    const section = lower(event?.section);
    if (section === "broadcast" && /^Swapped/u.test(String(event.method))) {
      const topics = (data?.operationStack ?? []).flatMap((item) => Array.isArray(item?.Xcm) ? [item.Xcm[0]] : []);
      if (topics.some((topic) => lower(topic) === lower(requestId))) swaps.push({ ...block, event: event.method, data });
    }
    if (section === "messagequeue" && event.method === "Processed" && lower(data?.id) === lower(requestId)) {
      processed.push({ ...block, id: data.id, sibling: raw(data.origin?.Sibling ?? -1), success: data.success });
    }
    if (section === "tokens" && event.method === "Withdrawn" && raw(data?.currencyId ?? -1) === 1003n) {
      const who = api.createType("AccountId32", data.who).toHex();
      if (lower(who) === lower(accountId32) && raw(data.amount) > 0n) positionDebits.push({ ...block, amount: raw(data.amount) });
    }
  }
  return { swaps, processed, positionDebits };
}

export function classifyRecallSell(observation, stagedShares) {
  const unknown = (reason) => ({ verdict: "unknown", reason });
  if (!observation?.scan?.complete || observation.errors?.length) return unknown("Far-side evidence is incomplete; human review required.");
  if (observation.book?.messageCount !== 0n) return unknown("Asset Hub message book is non-empty or unavailable; messages may still be queued.");
  const processed = observation.processed ?? [];
  if (!processed.length || processed.some((event) => event.sibling !== 1000n || typeof event.success !== "boolean")
    || processed.filter((event) => event.success).length !== 1 || processed.at(-1).success !== true) {
    return unknown("No successful messageQueue.Processed from Sibling 1000 for this request.");
  }
  const swaps = observation.swaps ?? [];
  if (swaps.length) {
    let valid = false;
    try {
      valid = swaps.length === 1 && swaps.every(({ data }) => {
        const input = data?.inputs?.find((item) => raw(item.asset) === 1003n);
        const output = data?.outputs?.find((item) => raw(item.asset) === 22n);
        const amount = raw(input?.amount ?? -1);
        return data?.fillerType === "AAVE" && amount === raw(output?.amount ?? -2)
          && amount >= BigInt(stagedShares) && amount - BigInt(stagedShares) <= BigInt(stagedShares) / 1000n + 16n;
      });
    } catch { /* malformed bound evidence is unknown, never permission to abandon */ }
    return valid ? { verdict: "sell_executed_unobserved", reason: "A request-bound AAVE unwind exists; resume observation, never abandon." }
      : unknown("Request-bound swap evidence exists but is ambiguous or outside the unwind law.");
  }
  const evm = observation.position?.evmRaw;
  const substrate = observation.position?.substrateRaw;
  if (evm === undefined || substrate === undefined || BigInt(evm) !== BigInt(substrate)
    || BigInt(evm) < BigInt(stagedShares) || BigInt(stagedShares) <= 0n) return unknown("The two aToken balance views do not prove the staged position is intact.");
  if (observation.positionDebits?.length) return unknown("aUSDC moved since dispatch; stop for human review.");
  return { verdict: "sell_not_executed", reason: "Message processed, no swap or position debit in its processing blocks, empty Asset Hub book, and both aToken views retain the staged shares." };
}

async function boundedRead(operation, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Recall observation read budget exhausted.");
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Recall observation read budget exhausted.")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

// Never infer message delivery from bitmap 4. Find the exact Hub dispatch,
// then locate the topic's processing blocks. Transact executes within message
// processing, not at an arbitrary later block. Read the WHOLE successful block
// before stopping, then require a fresh empty Asset Hub book and intact position.
export async function readRecallSellObservation({ provider, wrapperAddress, laneRequestId, fromHubBlock,
  hydrationApi: api, balanceReader, positionTarget, historyRange, timeoutMs = DEFAULT_OBSERVATION_TIMEOUT_MS }) {
  const observation = { laneRequestId, timeoutMs, scan: { complete: false }, swaps: [], processed: [], positionDebits: [], errors: [] };
  const deadline = Date.now() + timeoutMs;
  const read = (fn) => boundedRead(fn, deadline);
  try {
    const head = await read(() => provider.getBlockNumber());
    const logs = [];
    for (let start = fromHubBlock; start <= head; start += 2_000) {
      logs.push(...await read(() => provider.getLogs({ address: wrapperAddress,
        topics: [wrapperInterface.getEvent("RequestLegDispatched").topicHash, laneRequestId, toBeHex(2, 32)],
        fromBlock: start, toBlock: Math.min(head, start + 1_999) })));
    }
    if (logs.length !== 1 || logs[0].removed) throw new Error("Expected exactly one canonical withdraw_sell dispatch for the lane request.");
    const dispatched = wrapperInterface.parseLog(logs[0]);
    if (lower(dispatched.args.requestId) !== lower(laneRequestId) || Number(dispatched.args.leg) !== 2
      || getAddress(logs[0].address) !== getAddress(wrapperAddress)) throw new Error("Wrong withdraw_sell dispatch binding.");
    const hubBlock = await read(() => provider.getBlock(logs[0].blockNumber));
    if (!hubBlock || lower(hubBlock.hash) !== lower(logs[0].blockHash)) throw new Error("Sell dispatch block is not canonical.");
    observation.dispatch = { blockNumber: hubBlock.number, blockHash: hubBlock.hash,
      timestamp: hubBlock.timestamp, transactionHash: logs[0].transactionHash, messageHash: dispatched.args.messageHash };
    let hash = (await read(() => api.rpc.chain.getFinalizedHead())).toHex();
    let header = await read(() => api.rpc.chain.getHeader(hash));
    const number = header.number.toNumber();
    const { scan } = await read(() => historyRange(api, hubBlock.timestamp));
    if (scan.fromBlock > number || !hex32(hash)) throw new Error("Finalized Hydration head does not cover the sell dispatch.");
    observation.scan = { ...scan, toBlock: null, searchHead: number, timeoutMs, processingBlocks: [], complete: false };
    for (let blockNumber = scan.fromBlock; blockNumber <= number; blockNumber++) {
      const blockHash = (await read(() => api.rpc.chain.getBlockHash(blockNumber))).toHex();
      const blockApi = await read(() => api.at(blockHash));
      const records = (await read(() => blockApi.query.system.events())).toHuman();
      const found = collectRecallSellEvents(records, laneRequestId, { blockNumber, blockHash }, positionTarget.account, api);
      observation.scan.toBlock = blockNumber;
      if (!found.processed.length) {
        if (found.swaps.length) throw new Error("Topic-bound swap without its Processed event; processing proof is inconsistent.");
        continue;
      }
      observation.scan.processingBlocks.push({ blockNumber, blockHash });
      for (const key of ["swaps", "processed", "positionDebits"]) observation[key].push(...found[key]);
      // collectRecallSellEvents reads every event, including swaps/debits AFTER
      // Processed in this block's event array, before this early-stop decision.
      if (found.processed.some((event) => event.sibling === 1000n && event.success === true)) {
        observation.scan.complete = true;
        observation.scan.stopReason = "successful_topic_processed";
        break;
      }
    }
    if (!observation.scan.complete) throw new Error("No successful Processed for the topic before the finalized search head.");
    // Queue state and BOTH balances are current at the same finalized block,
    // not the historical processing block and not a pre-scan cached snapshot.
    hash = (await read(() => api.rpc.chain.getFinalizedHead())).toHex();
    header = await read(() => api.rpc.chain.getHeader(hash));
    const observedNumber = header.number.toNumber();
    if (!hex32(hash) || observedNumber < observation.scan.toBlock) throw new Error("Observation head precedes message processing.");
    observation.hydrationBlock = { number: observedNumber, hash };
    const at = await read(() => api.at(hash));
    const [evm, substrate, book] = await Promise.all([
      read(() => balanceReader.read(positionTarget, { blockTag: observedNumber })),
      // CurrenciesApi knows asset 1003 is ERC20. Tokens.accounts(1003) is NOT
      // the aToken ledger and reads zero even when the position is healthy.
      read(() => at.call.currenciesApi.freeBalance(1003, positionTarget.account)),
      read(() => at.query.messageQueue.bookStateFor({ Sibling: 1000 })),
    ]);
    // Polkadot JS exposes the runtime's message_count field as messageCount.
    // Missing/changed schema must refuse, never default to an empty book.
    observation.book = { origin: { Sibling: 1000 }, messageCount: raw(book.messageCount), blockNumber: observedNumber, blockHash: hash };
    observation.position = { evmRaw: BigInt(evm.raw), substrateRaw: raw(substrate),
      accountId32: positionTarget.account, evmAccount: positionTarget.account.slice(0, 42),
      aToken: positionTarget.contract, substrateView: "CurrenciesApi.freeBalance(1003, accountId32)" };
  } catch (error) {
    observation.errors.push(String(error.message));
  }
  return observation;
}

export function assertAbandonUnexecutedSell({ wrapperRecord, bitmap, laneRequest, pendingWithdrawalShares, observation }) {
  const shares = BigInt(wrapperRecord?.context?.shares ?? 0);
  if (BigInt(bitmap) !== 4n || Number(wrapperRecord?.status) !== 1 || Number(wrapperRecord?.context?.kind) !== 1) {
    throw new Error("Abandon gate: wrapper must be Pending Withdraw with bitmap exactly 4.");
  }
  if (Number(laneRequest?.status) !== 1 || Number(laneRequest?.kind) !== 1 || laneRequest?.settled !== false
    || shares <= 0n || BigInt(laneRequest?.requestedShares ?? -1) !== shares || BigInt(pendingWithdrawalShares) !== shares) {
    throw new Error("Abandon gate: Pending lane withdrawal and pendingWithdrawalShares must equal the staged shares.");
  }
  const classification = classifyRecallSell(observation, shares);
  if (classification.verdict !== "sell_not_executed" || !hex32(observation.hydrationBlock?.hash)
    || observation.hydrationBlock.hash === ZERO32) throw new Error(`Abandon gate: ${classification.verdict}: ${classification.reason}`);
  return { ...classification, stagedShares: shares };
}

export function buildAbandonSellCall(laneRequestId, remoteRef) {
  if (!hex32(laneRequestId) || !hex32(remoteRef) || remoteRef === ZERO32) throw new Error("Abandon settlement needs request and observation block hashes.");
  // Ruling A: intact aUSDC remains in totalAssets/totalShares. Zero means no
  // assets LEFT that position and became stranded; the observed balance is
  // preserved separately in the evidence, never booked as a second receivable.
  return laneInterface.encodeFunctionData("settleRequest", [laneRequestId, 3, 0n, 0n, 0n, remoteRef, SELL_NOT_EXECUTED]);
}

export async function abandonUnexecutedSell({ laneRequestId, laneAddress, readFresh, provider, signer, runners = [],
  commit = false, emit = () => {}, wait = waitForTransaction, timeoutMs = DEFAULT_BROKERED_TX_TIMEOUT_MS }) {
  let evidence = { operation: "abandon_unexecuted_sell", laneRequestId, mode: commit ? "commit" : "dry-run" };
  try {
    // readFresh re-reads both chains; nothing in a prior run record authorizes a write.
    const before = await readFresh();
    evidence = { ...evidence, before };
    if (lower(before.observation?.laneRequestId) !== lower(laneRequestId)) throw new Error("Abandon observation is for a different lane request.");
    const verdict = assertAbandonUnexecutedSell(before);
    const data = buildAbandonSellCall(laneRequestId, before.observation.hydrationBlock.hash);
    evidence = { ...evidence, before, verdict, observedRemoteBalanceRaw: 0n,
      transaction: { to: laneAddress, data, value: "0" } };
    await provider.call({ from: signer.address, to: laneAddress, data, value: 0n });
    if (!commit) return { ...evidence, preflight: "success" };
    const tx = await signer.sendTransaction({ to: laneAddress, data, value: 0n });
    evidence.transaction.hash = tx.hash;
    const receipt = await wait(tx, { stage: "recall.abandonUnexecutedSell", timeoutMs, runners,
      logger: { info: (record) => emit(record) }, persist: async (record) => emit({ event: "recall_abandon_transaction", ...record }) });
    if (!receipt || Number(receipt.status) !== 1) throw new Error("Abandon settlement receipt is not successful.");
    const after = await readFresh({ postcondition: true });
    if (BigInt(after.pendingWithdrawalShares) !== 0n || Number(after.wrapperRecord.status) !== 3
      || Number(after.laneRequest.status) !== 3 || !after.laneRequest.settled
      || after.requiresRemoteRecovery !== false || BigInt(after.recoveryAssetsOutstanding) !== 0n
      || BigInt(after.totalAssets) !== BigInt(before.totalAssets) || BigInt(after.totalShares) !== BigInt(before.totalShares)
      || BigInt(after.laneRequest.settledAssets) !== 0n || BigInt(after.laneRequest.settledShares) !== 0n
      || BigInt(after.bitmap) !== 4n || lower(after.laneRequest.failureCode) !== lower(SELL_NOT_EXECUTED)
      || lower(after.wrapperRecord.failureCode) !== lower(SELL_NOT_EXECUTED)
      || lower(after.laneRequest.remoteRef) !== lower(before.observation.hydrationBlock.hash)
      || lower(after.wrapperRecord.remoteRef) !== lower(before.observation.hydrationBlock.hash)) {
      throw new Error("Abandon postcondition failed: expected Failed, zero pending/recovery, and unchanged lane position accounting.");
    }
    return { ...evidence, receipt: { hash: tx.hash, blockNumber: receipt.blockNumber }, after };
  } catch (error) {
    error.unwindEvidence = evidence;
    throw error;
  }
}
