#!/usr/bin/env node
// Operator-only October sweep. This module never starts the backend or its keepers.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Contract, FetchRequest, Interface, JsonRpcProvider, encodeBytes32String, getAddress, id } from "ethers";
import { ESCROW_CORE_ABI, AGENT_ACCOUNT_ABI } from "../../mcp-server/src/blockchain/abis.js";

export const CHAIN_ID = 420420419;
export const STRATEGY = "AAC_IDLE_DEPOSIT_POOL_V21";
export const STRATEGY_ID = encodeBytes32String(STRATEGY);
// Resolved from the packet's B' job by read-only jobs() at implementation time.
export const COLD_POSTER = "0xA287a52bb9624a4c2fE97E60D59B0de584A37bf6";
export const ADDRESSES = Object.freeze({
  signer: "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
  v3: "0xC2Eb191FB75246667226a5D5Db9d821f95a5f793",
  v2: "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC",
  aac: "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57",
  adapter: "0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5",
  pool: "0x9B35A102d656Fb86d798aF81959e09961DEc28E0",
  asset: "0x0000053900000000000000000000000001200000"
});
// Prefix deny is deliberately stronger than the abbreviated packet's unknown-
// owner ID. Neither editing the manifest nor selecting a different escrow bypasses it.
export const DENYLIST = Object.freeze({
  "0x1ca6302b": "platform-fault dispute: phone arbitrator only; full worker payout",
  "0xfc11092a": "platform-fault dispute: phone arbitrator only; full worker payout",
  "0xfd4fdf36": "platform-fault dispute: phone arbitrator only; full worker payout",
  "0xdbb87130": "unknown poster ownership; out of scope"
});
export function assertAllowedId(jobId) {
  if (!/^0x[0-9a-f]{64}$/i.test(jobId)) throw new Error("Invalid explicit job ID");
  for (const [prefix, reason] of Object.entries(DENYLIST)) {
    if (jobId.toLowerCase().startsWith(prefix)) throw new Error(`Denied ${jobId}: ${reason}`);
  }
}
export const EVENTS = { A: "JobCancelled", B: "JobClosed", "B'": "JobClosed", C: "StrategyDeallocated", D: "JobReopened" };
const STATES = ["None", "Open", "Claimed", "Submitted", "Rejected", "Disputed", "Closed", "Cancelled"];
const escrowAbi = [...ESCROW_CORE_ABI.filter((s) => /^(function (jobs|accounts|policy|cancelOpenJob|finalizeRejectedJob|handleClaimTimeout)\(|event (JobCancelled|JobClosed|JobReopened|Verified|JobRejected)\()/.test(s)),
  "function policy() view returns (address)",
  "function createdAt(bytes32) view returns (uint256)", "function MIN_OPEN_FOR_CANCEL() view returns (uint256)",
  "function DISPUTE_WINDOW() view returns (uint256)"];
const accountAbi = [...AGENT_ACCOUNT_ABI.filter((s) => /^function (positions|strategyShares|deallocateIdleFunds)\(/.test(s)),
  "function registry() view returns (address)", "function policy() view returns (address)",
  "function treasuryAccount() view returns (address)",
  "event StrategyDeallocated(address indexed account,bytes32 indexed strategyId,address indexed asset,uint256 amount)"];
const policyAbi = ["function paused() view returns (bool)", "function claimFeeVerifierBps() view returns (uint16)"];
const adapterAbi = ["function totalAssets() view returns (uint256)", "function totalShares() view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)", "function pool() view returns (address)",
  "function pendingDepositAssets() view returns (uint256)"];
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const json = (v) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
const plain = (v) => JSON.parse(json(v));
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return typeof v === "bigint" ? v.toString() : v;
}
export const hash = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export function validateManifest(manifest) {
  if (manifest.schemaVersion !== "averray.signer-cleanup.v1" || !Array.isArray(manifest.rows)) throw new Error("Invalid cleanup manifest");
  const seen = new Set(); let last = -1;
  for (const row of manifest.rows) {
    if (row.jobId) assertAllowedId(row.jobId);
    const order = ["A", "B", "B'", "C", "D"].indexOf(row.bucket);
    const fn = { A: "cancelOpenJob", B: "finalizeRejectedJob", "B'": "finalizeRejectedJob", C: "deallocateIdleFunds", D: "handleClaimTimeout" }[row.bucket];
    const targets = { A: ["v3"], B: ["v2", "v3"], "B'": ["v2"], C: ["aac"], D: ["v2"] }[row.bucket] ?? [];
    if (order < last || !fn || row.function !== fn || !targets.includes(row.escrow)) throw new Error("Manifest call/order outside cleanup scope");
    if (row.bucket === "C" ? row.strategy !== STRATEGY || row.jobId : !row.jobId) throw new Error("Manifest strategy/job outside cleanup scope");
    const key = `${row.escrow}:${row.jobId ?? row.strategy}`;
    if (seen.has(key)) throw new Error("Duplicate cleanup row");
    seen.add(key); last = order;
  }
  for (const jobId of manifest.rescueJobIds ?? []) assertAllowedId(jobId);
}
export function refundable(job) {
  return BigInt(job.reward) - BigInt(job.released) + BigInt(job.protocolFee) - BigInt(job.protocolFeeReleased)
    + BigInt(job.opsReserve) + BigInt(job.contingencyReserve);
}
export function classify(row, snapshot, signer = ADDRESSES.signer) {
  const job = snapshot.job;
  const base = { row, state: row.bucket === "C" ? "strategy" : STATES[Number(job.state)] ?? "Unknown",
    heldRaw: row.bucket === "C" ? "0" : refundable(job).toString(),
    worker: job?.worker ?? null, slashStakeRaw: String(job?.claimStake ?? 0), slashFeeRaw: String(job?.claimFee ?? 0),
    refundRecipient: job?.poster ?? signer, ...(snapshot.fairness ? { fairness: snapshot.fairness } : {}),
    preState: snapshot.preState ?? plain(snapshot) };
  // Observation time decides eligibility but is not pre-state: advancing the
  // chain alone must not invalidate every reviewed plan.
  delete base.preState.now;
  const result = (status, reason, amount = 0n) => ({ ...base, status, ...(reason ? { reason } : {}),
    call: { to: ADDRESSES[row.escrow], function: row.function,
      args: row.bucket === "C" ? [signer, STRATEGY_ID, String(amount)] : [row.jobId] },
    expectedBankLiquidRaw: status === "ready" && equal(base.refundRecipient, signer) && row.bucket !== "D"
      ? String(row.bucket === "C" ? amount : refundable(job)) : "0",
    expectedBankReservedRaw: status === "ready" && equal(base.refundRecipient, signer) && !["C", "D"].includes(row.bucket) ? String(-refundable(job)) : "0",
    expectedColdLiquidRaw: status === "ready" && row.bucket === "B'" ? String(refundable(job)) : "0" });
  if (row.bucket === "C") {
    const shares = BigInt(snapshot.shares), totalShares = BigInt(snapshot.totalShares), totalAssets = BigInt(snapshot.totalAssets);
    if (shares === 0n) return result("already_done");
    if (snapshot.paused) return result("blocked", "paused");
    if (!snapshot.active) return result("blocked", "strategy_inactive");
    if (snapshot.async) return result("blocked", "strategy_async");
    if (!snapshot.bindingsValid) return result("blocked", "strategy_binding_mismatch");
    if (totalShares === 0n || totalAssets === 0n || shares > totalShares) return result("blocked", "invalid_strategy_totals");
    const amount = shares * totalAssets / totalShares;
    base.heldRaw = String(amount);
    if (amount === 0n) return result("blocked", "dust_has_no_withdrawable_value");
    // Match AAC's ceil share burn, then the adapter's floor assets returned.
    const burned = (amount * totalShares + totalAssets - 1n) / totalAssets;
    const returned = burned * totalAssets / totalShares;
    if (returned > BigInt(snapshot.buffer)) return result("blocked", "buffer_short");
    return result("ready", undefined, amount);
  }
  const state = Number(job.state);
  if ((row.bucket === "A" && state === 7) || (["B", "B'"].includes(row.bucket) && state === 6)
      || (row.bucket === "D" && [1, 4, 6, 7].includes(state))) return result("already_done");
  if (snapshot.paused) return result("blocked", "paused");
  if (!snapshot.bindingsValid || !equal(job.asset, ADDRESSES.asset)) return result("blocked", "contract_or_asset_mismatch");
  if (!equal(job.poster, row.bucket === "B'" ? COLD_POSTER : signer)) return result("blocked", "poster_mismatch");
  if (row.bucket === "A") {
    if (state !== 1) return result("blocked", "not_open");
    if (snapshot.now < Number(snapshot.createdAt) + Number(snapshot.minOpenAge)) return result("blocked", "open_floor_active");
  } else if (["B", "B'"].includes(row.bucket)) {
    if (state !== 4) return result("blocked", "not_rejected");
    if (!Number(job.rejectedAt) || snapshot.now <= Number(job.rejectedAt) + Number(snapshot.disputeWindow)) return result("blocked", "dispute_window_active");
  } else {
    if (state !== 2) return result("blocked", "not_claimed");
    if (!Number(job.claimExpiry) || snapshot.now <= Number(job.claimExpiry)) return result("blocked", "claim_not_expired");
    // Retirement does not prevent a direct permissionless legacy claim. Until
    // rescue prepare is integrated in this stopped/locked session, never reopen.
    return result("blocked", "same_session_rescue_required");
  }
  if (["A", "D"].includes(row.bucket) && snapshot.retired !== true) return result("blocked", "persisted_catalogue_retirement_required");
  return result("ready");
}
export function buildPlan(rows, position) {
  const planHash = hash({ chainId: CHAIN_ID, contracts: ADDRESSES, ready: rows.filter(r => r.status === "ready").map(r => ({ call: r.call, preState: r.preState })) });
  const total = (key) => String(rows.reduce((n, r) => n + BigInt(r[key]), 0n));
  return { chainId: CHAIN_ID, contracts: ADDRESSES, rows, position, planHash,
    totals: { bankLiquidRaw: total("expectedBankLiquidRaw"), bankReservedRaw: total("expectedBankReservedRaw"), coldLiquidRaw: total("expectedColdLiquidRaw") } };
}
export function assertCommit(plan, args) {
  if (args.expectedPlanHash !== plan.planHash) throw new Error("Plan hash mismatch; obtain and review a fresh dry-run");
  if (args.confirm !== `CLEANUP ${plan.planHash.slice(0, 12)}`) throw new Error("Confirmation mismatch");
}
export async function assertNonceIdle(provider, signer = ADDRESSES.signer) {
  // Raw RPC avoids ethers' short-lived transaction-count cache.
  const latest = BigInt(await provider.send("eth_getTransactionCount", [signer, "latest"]));
  const pending = BigInt(await provider.send("eth_getTransactionCount", [signer, "pending"]));
  if (latest !== pending) throw new Error(`signer_nonce_busy latest=${latest} pending=${pending}`);
  return { latest: String(latest), pending: String(pending) };
}
export function receiptEvidence(receipt, classified) {
  if (Number(receipt.status) !== 1) throw new Error("Transaction reverted");
  const iface = new Interface(classified.row.bucket === "C" ? accountAbi : escrowAbi);
  const event = EVENTS[classified.row.bucket];
  const logs = receipt.logs.filter(l => equal(l.address, classified.call.to)).flatMap(l => { try { return [iface.parseLog(l)]; } catch { return []; } });
  const matches = logs.filter(l => l?.name === event && (classified.row.bucket === "C"
    ? equal(l.args.account, ADDRESSES.signer) && equal(l.args.strategyId, STRATEGY_ID) && equal(l.args.asset, ADDRESSES.asset)
    : equal(l.args.jobId, classified.row.jobId)));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous expected ${event} event`);
  return { txHash: receipt.hash, block: receipt.blockNumber, row: classified.row, event, args: plain(matches[0].args.toObject()) };
}
export async function executePlan(plan, args, io) {
  assertCommit(plan, args);
  const done = [], skipped = [], pending = plan.rows.filter(r => r.status === "ready");
  const deadline = io.now() + 14 * 60_000; // host watchdog is the independent 15-minute backstop
  let failure;
  try {
    for (const original of pending) {
      if (io.now() >= deadline) throw new Error("cleanup_stopped_window_budget_exhausted");
      const fresh = await io.read(original.row);
      if (fresh.status !== "ready" || (original.row.bucket !== "C" && hash(fresh.preState) !== hash(original.preState))) {
        skipped.push({ row: original.row, status: fresh.status, reason: fresh.reason ?? "pre_state_changed" });
        io.log({ type: "skipped", ...skipped.at(-1) }); continue;
      }
      await io.assertNonceIdle();
      if (io.now() >= deadline) throw new Error("cleanup_stopped_window_budget_exhausted");
      // Fresh C call carries the full send-time position, not the preview amount.
      if (fresh.row.jobId) assertAllowedId(fresh.row.jobId);
      if (fresh.row.bucket !== "C") assertAllowedId(fresh.call.args[0]);
      const tx = await io.send(fresh.call);
      io.log({ type: "broadcast", row: fresh.row, txHash: tx.hash, nonce: tx.nonce });
      const remaining = deadline - io.now();
      if (remaining <= 0) throw new Error("cleanup_stopped_window_budget_exhausted_after_broadcast");
      const receipt = await tx.wait(1, Math.min(60_000, remaining));
      const evidence = (io.receiptEvidence ?? receiptEvidence)(receipt, fresh);
      done.push(evidence); io.log({ type: "receipt", ...evidence });
    }
  } catch (error) { failure = error; }
  const notDone = pending.filter(r => !done.some(d => json(d.row) === json(r.row)) && !skipped.some(s => json(s.row) === json(r.row))).map(r => r.row);
  let position;
  try { position = await io.position(); } catch (error) { io.log({ type: "postcondition_unavailable", reason: error.message }); failure ??= error; }
  const delta = position && { liquid: String(BigInt(position.liquid) - BigInt(plan.position.liquid)), reserved: String(BigInt(position.reserved) - BigInt(plan.position.reserved)) };
  io.log({ type: "summary", done, skipped, notDone, position, delta,
    gap: delta && { liquid: String(BigInt(delta.liquid) - BigInt(plan.totals.bankLiquidRaw)), reserved: String(BigInt(delta.reserved) - BigInt(plan.totals.bankReservedRaw)) },
    error: failure?.message });
  if (failure) throw failure;
  return { done, skipped, notDone, position };
}

export function retirementFor(records, chainJobId) {
  return records.some(r => r.schemaVersion === 1 && typeof r.jobId === "string"
    && equal(/^0x[0-9a-f]{64}$/i.test(r.jobId) ? r.jobId : id(r.jobId), chainJobId)
    && ["archived", "paused"].includes(r.lifecycle?.status));
}
export function slashDistribution(row, job, treasury, verifierBps) {
  const stake = BigInt(job.claimStake), fee = BigInt(job.claimFee);
  const verifier = row.bucket === "D" ? null : job.rejectingVerifier;
  const verifierAmount = !verifier || /^0x0{40}$/i.test(verifier) ? 0n : fee * BigInt(verifierBps) / 10_000n;
  return {
    asset: job.asset, worker: job.worker, conditionalOnExecution: true,
    stake: { totalRaw: String(stake), posterWallet: job.poster, posterWalletRaw: String(stake / 2n),
      treasuryAccount: treasury, treasuryAacRaw: String(stake - stake / 2n) },
    fee: { totalRaw: String(fee), verifierWallet: verifier, verifierWalletRaw: String(verifierAmount),
      treasuryAccount: treasury, treasuryAacRaw: String(fee - verifierAmount) },
    note: "Poster/verifier shares are external wallet transfers, NOT reward-bank AAC liquid. Treasury shares credit its AAC position."
  };
}
export async function readRejectionEvidence(provider, row, job, head, readSession, earliestBlock = 0) {
  let backend;
  try {
    const session = await readSession?.(row.jobId);
    backend = !readSession ? { status: "unavailable", reason: "backend_session_store_not_configured" }
      : !session ? { status: "not_found" }
        : { status: "available", sessionId: session.sessionId, verdictReason: session.verification?.reason ?? null,
          verdictReasonCode: session.verification?.reasonCode ?? null };
  } catch { backend = { status: "unavailable", reason: "backend_session_read_failed" }; }
  // Claim timeouts have no current rejection. Do not invent a verifier verdict.
  if (!Number(job.rejectedAt)) return { backend, chain: { status: "not_applicable", reason: "no_current_rejection", events: [] } };
  try {
    const timestamp = Number(job.rejectedAt);
    // Locate the exact rejectedAt timestamp, not an unbounded deployment-to-head
    // log scan. Equal-timestamp blocks are included; excessive ranges fail loud.
    const boundary = async (after) => {
      let low = earliestBlock, high = head.number + 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2), block = await provider.getBlock(mid);
        if (!block) throw new Error("rejection_block_unavailable");
        if (Number(block.timestamp) < timestamp || (after && Number(block.timestamp) === timestamp)) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const fromBlock = await boundary(false), toBlock = (await boundary(true)) - 1;
    if (toBlock < fromBlock || toBlock - fromBlock > 128) throw new Error("rejection_block_range_unavailable");
    const iface = new Interface(escrowAbi);
    const logs = await provider.getLogs({ address: ADDRESSES[row.escrow], fromBlock, toBlock,
      topics: [[iface.getEvent("Verified").topicHash, iface.getEvent("JobRejected").topicHash], row.jobId] });
    const events = [];
    for (const log of logs) {
      if (!equal(log.address, ADDRESSES[row.escrow])) continue;
      const parsed = iface.parseLog(log);
      if (!equal(parsed.args.jobId, row.jobId) || (parsed.name === "Verified" && parsed.args.approved)) continue;
      const block = await provider.getBlock(log.blockNumber);
      if (!block || Number(block.timestamp) !== timestamp) continue;
      events.push({ event: parsed.name, reasonCode: parsed.args.reasonCode,
        reasoningHash: parsed.args.reasoningHash ?? null, verifier: parsed.args.verifier ?? job.rejectingVerifier,
        verifierSource: parsed.name === "Verified" ? "event" : "job.rejectingVerifier",
        block: log.blockNumber, blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
        transactionHash: log.transactionHash });
    }
    return { backend, chain: { status: events.some(e => e.event === "Verified") && events.some(e => e.event === "JobRejected") ? "available" : "incomplete",
      events, note: "Operator must review reason codes/hashes for platform faults before approving any slash; missing evidence is not exoneration." } };
  } catch (error) { return { backend, chain: { status: "unavailable", reason: error.code ?? error.message, events: [] } }; }
}
export async function createReader(provider, deployments, { readRetirements = async () => [], readSession } = {}) {
  const aac = new Contract(ADDRESSES.aac, accountAbi, provider);
  const escrow = Object.fromEntries(["v2", "v3"].map(k => [k, new Contract(ADDRESSES[k], escrowAbi, provider)]));
  const adapter = new Contract(ADDRESSES.adapter, adapterAbi, provider);
  const position = async () => plain((await aac.positions(ADDRESSES.signer, ADDRESSES.asset)).toObject());
  const read = async (row) => {
    const head = await provider.getBlock("latest"); if (!head) throw new Error("Latest block unavailable");
    const at = { blockTag: head.number };
    const observed = result => ({ ...result, observation: { block: head.number, timestamp: head.timestamp } });
    if (row.bucket === "C") {
      const registryAddress = await aac.registry(at), policyAddress = await aac.policy(at);
      const registry = new Contract(registryAddress, ["function getStrategy(bytes32) view returns ((bytes32 strategyId,address adapter,address asset,string riskLabel,bool active))"], provider);
      const strategy = await registry.getStrategy(STRATEGY_ID, at);
      let async = false;
      try { await adapter.pendingDepositAssets(at); async = true; } catch (error) { if (error.code !== "CALL_EXCEPTION") throw error; }
      return observed(classify(row, { now: head.timestamp, shares: await aac.strategyShares(ADDRESSES.signer, STRATEGY_ID, at),
        totalAssets: await adapter.totalAssets(at), totalShares: await adapter.totalShares(at), buffer: await adapter.maxWithdraw(ADDRESSES.aac, at),
        paused: await new Contract(policyAddress, policyAbi, provider).paused(at), active: strategy.active, async,
        bindingsValid: equal(registryAddress, deployments.contracts.strategyAdapterRegistry) && equal(policyAddress, deployments.contracts.treasuryPolicy)
          && equal(strategy.adapter, ADDRESSES.adapter) && equal(strategy.asset, ADDRESSES.asset) && equal(await adapter.pool(at), ADDRESSES.pool) }));
    }
    const contract = escrow[row.escrow];
    const job = plain((await contract.jobs(row.jobId, at)).toObject());
    const policyAddress = await contract.policy(at);
    const snapshot = { now: head.timestamp, job, paused: await new Contract(policyAddress, policyAbi, provider).paused(at),
      bindingsValid: equal(await contract.accounts(at), ADDRESSES.aac) && equal(policyAddress, deployments.contracts.treasuryPolicy) };
    if (row.bucket === "A") { snapshot.createdAt = await contract.createdAt(row.jobId, at); snapshot.minOpenAge = await contract.MIN_OPEN_FOR_CANCEL(at); }
    if (["B", "B'"].includes(row.bucket)) snapshot.disputeWindow = await contract.DISPUTE_WINDOW(at);
    if (["A", "D"].includes(row.bucket)) snapshot.retired = retirementFor(await readRetirements(), row.jobId);
    if (["B", "B'", "D"].includes(row.bucket)) {
      // Earliest escrow deployment is a conservative lower bound for both
      // generations. Hub does not serve EVM headers back to Substrate genesis.
      snapshot.fairness = { ...await readRejectionEvidence(provider, row, job, head, readSession, deployments.deploymentBlocks.escrowCore),
        slashes: slashDistribution(row, job, await aac.treasuryAccount(at),
          await new Contract(policyAddress, policyAbi, provider).claimFeeVerifierBps(at)) };
    }
    return observed(classify(row, snapshot));
  };
  return { read, position };
}
export function parseArgs(argv) {
  const args = { commit: false };
  const values = { "--profile": "profile", "--expected-signer": "expectedSigner", "--expected-plan-hash": "expectedPlanHash", "--confirm": "confirm" };
  for (let n = 0; n < argv.length; n++) {
    const flag = argv[n];
    if (values[flag]) { const value = argv[++n]; if (!value || value.startsWith("--")) throw new Error(`Missing ${flag}`); args[values[flag]] = value; }
    else if (flag === "--commit") args.commit = true;
    else if (flag === "--nonce-check") args.nonceCheck = true;
    else if (flag === "--use-kms") args.useKms = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (args.profile !== "mainnet") throw new Error("Only --profile mainnet is in scope");
  if (args.commit && (!args.useKms || !args.expectedSigner || !args.expectedPlanHash || !args.confirm)) throw new Error("Commit requires KMS, expected signer, reviewed plan hash and confirmation");
  return args;
}
export function rescueCommands(manifest) {
  const common = `node scripts/ops/rescue-open-job.mjs --profile mainnet --escrow legacy --job-ids ${manifest.rescueJobIds.join(",")} --janitor "\${JANITOR:?set the dedicated janitor address}" --expected-signer ${ADDRESSES.signer}`;
  return { prepare: `${common} --phase prepare`, finalize: `${common} --phase finalize`,
    blocked: "D remains blocked: these combined commands are NOT executable until a separately reviewed same-session reopen/rescue integration exists. Catalogue retirement alone cannot prevent direct legacy claims.",
    execution: "Each is a separate dry-run and combined plan. Add --use-kms --execute --expected-plan-hash <combined hash> --confirm 'RESCUE <combined hash>' (or FINALIZE).",
    earliestFinalize: "For each job: actual prepare JobRejected block timestamp + live DISPUTE_WINDOW + 1 second (currently 7 days). Finalize dry-run prints the exact chain-derived time; not the cleanup time." };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const deployments = JSON.parse(await readFile(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("./signer-cleanup-2026-10.json", import.meta.url), "utf8"));
  validateManifest(manifest);
  const expected = getAddress(args.expectedSigner ?? deployments.verifier);
  if (!equal(expected, ADDRESSES.signer) || !equal(deployments.verifier, expected)) throw new Error("Unexpected cleanup signer");
  for (const [name, key] of Object.entries({ v3: "escrowCore", v2: "legacyEscrowCore", aac: "agentAccountCore", adapter: "aacPoolAggregatorAdapter", pool: "depositPoolV21" })) {
    if (!equal(deployments.contracts[key], ADDRESSES[name])) throw new Error(`Deployment binding changed: ${key}`);
  }
  const request = new FetchRequest(deployments.rpcUrl); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
  let store;
  const log = (value) => console.log(json(value));
  try {
    if (Number(BigInt(await provider.send("eth_chainId", []))) !== CHAIN_ID) throw new Error("Wrong chain");
    if (args.nonceCheck) { log({ type: "signer_nonce", at: new Date().toISOString(), ...await assertNonceIdle(provider) }); return; }
    // Existing backend Redis configuration only. No catalogue writes here.
    if (process.env.REDIS_URL) {
      const { createStateStore } = await import("../../mcp-server/src/core/state-store.js");
      store = createStateStore();
    }
    const io = await createReader(provider, deployments, { readRetirements: () => store?.listCatalogueMutations() ?? Promise.resolve([]),
      readSession: store ? jobId => store.findSessionByChainJobId(jobId) : undefined });
    const rows = [];
    for (const row of manifest.rows) { const result = await io.read(row); rows.push(result); log({ type: "row", ...result }); }
    const plan = buildPlan(rows, await io.position());
    log({ type: "plan", chainId: plan.chainId, contracts: plan.contracts, position: plan.position, totals: plan.totals, planHash: plan.planHash });
    log({ type: "rescue_next_steps", ...rescueCommands(manifest) });
    if (!args.commit) { log({ type: "dry_run", noKms: true, noTransactions: true, catalogueNote: "A requires persisted paused/archived catalogue records. D is blocked pending same-session rescue integration, even if retired or absent from the catalogue." }); return plan; }
    assertCommit(plan, args);
    if (!plan.rows.some(r => r.status === "ready")) { log({ type: "no_op", reason: "no_ready_rows" }); return plan; }
    await assertNonceIdle(provider);
    // Dynamic import and signer construction occur only AFTER all commit gates.
    const { KmsSigner } = await import("../../mcp-server/src/blockchain/kms-signer.js");
    const signer = new KmsSigner({ keyId: process.env.KMS_KEY_ID, region: process.env.AWS_REGION, provider });
    if (!equal(await signer.getAddress(), expected)) throw new Error("KMS signer mismatch");
    return await executePlan(plan, args, { ...io, now: Date.now, log, assertNonceIdle: () => assertNonceIdle(provider),
      send: (call) => new Contract(call.to, call.function === "deallocateIdleFunds" ? accountAbi : escrowAbi, signer)[call.function](...call.args) });
  } finally { if (store?.client?.isOpen) await store.client.disconnect(); provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(json({ type: "cleanup_failed", name: error.name, code: error.code, message: error.message })); process.exitCode = 1; });
}
