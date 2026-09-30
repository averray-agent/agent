export const JOBS_SELECTOR = "0x38ed7cfc";
export const SLA_SELECTOR = "0x3416e75d";
export const DISPUTE_OPENED_TOPIC = "0x74b30b10e89fcaa4fc5ffe4cbad394399cd7cfe59529e41170312d28377b874d";
export const EXPECTED_SLA_SECONDS = 1_209_600;
export const MAINNET_CHAIN_ID = 420_420_419;

export async function rpcRead(url, method, params, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("rpc_http_error");
  const data = await response.json();
  if (data.error) throw new Error(String(data.error.message ?? "rpc_error"));
  if (data.result === undefined) throw new Error("rpc_result_missing");
  return data.result;
}

const hexBlock = (value) => `0x${value.toString(16)}`;
export async function readDisputeLogs({ url, escrow, fromBlock, toBlock, read = rpcRead }) {
  const logs = [];
  let cursor = fromBlock;
  let size = 50_000;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + size - 1);
    try {
      const page = await read(url, "eth_getLogs", [{ address: escrow, topics: [DISPUTE_OPENED_TOPIC],
        fromBlock: hexBlock(cursor), toBlock: hexBlock(end) }]);
      if (!Array.isArray(page)) throw new Error("rpc_logs_invalid");
      for (const log of page) {
        if (log.removed) continue;
        if (log.address?.toLowerCase() !== escrow.toLowerCase() || log.topics?.[0] !== DISPUTE_OPENED_TOPIC
          || !/^0x[\da-f]{64}$/i.test(log.topics?.[1] ?? "")) throw new Error("rpc_log_invalid");
        logs.push(log);
      }
      cursor = end + 1;
    } catch (error) {
      if (size <= 1 || !/range|limit|too large|too many|response size|query returned|maximum/i.test(error.message)) throw error;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return logs;
}

export function decodeJob(result) {
  if (!/^0x[\da-f]{1600}$/i.test(result)) throw new Error("rpc_job_shape_invalid");
  const word = (index) => BigInt(`0x${result.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
  const disputedAt = Number(word(18));
  const state = Number(word(20));
  if (!Number.isSafeInteger(disputedAt) || state < 0 || state > 7) throw new Error("rpc_job_value_invalid");
  return { disputedAt, state };
}

export async function readArbitrationChain(manifest, { read = rpcRead } = {}) {
  const urls = [...new Set([manifest.rpcUrl, ...(manifest.rpcBackupUrls ?? [])])];
  const contracts = [
    { escrow: manifest.contracts.escrowCore, fromBlock: manifest.deploymentBlocks.escrowCoreV3 },
    { escrow: manifest.contracts.legacyEscrowCore, fromBlock: manifest.deploymentBlocks.escrowCoreV2 },
  ];
  if (urls.length < 2 || contracts.some(({ escrow, fromBlock }) => !/^0x[\da-f]{40}$/i.test(escrow)
    || !Number.isSafeInteger(fromBlock))) throw new Error("chain_configuration_invalid");
  const scans = await Promise.all(urls.map(async (url) => {
    const found = new Map();
    const failures = [];
    try {
      if (Number(BigInt(await read(url, "eth_chainId", []))) !== MAINNET_CHAIN_ID) throw new Error("rpc_chain_invalid");
      const head = Number(BigInt(await read(url, "eth_blockNumber", [])));
      if (!Number.isSafeInteger(head)) throw new Error("rpc_head_invalid");
      await Promise.all(contracts.map(async ({ escrow, fromBlock }) => {
        try {
          const sla = Number(BigInt(await read(url, "eth_call", [{ to: escrow, data: SLA_SELECTOR }, "latest"])));
          if (sla !== EXPECTED_SLA_SECONDS) throw new Error("arbitration_sla_invalid");
          const logs = await readDisputeLogs({ url, escrow, fromBlock, toBlock: head, read });
          for (const log of logs) {
            const jobId = log.topics[1].toLowerCase();
            found.set(`${escrow.toLowerCase()}:${jobId}`, { escrow, jobId, sla });
          }
        } catch { failures.push("contract_read_failed"); }
      }));
    } catch { failures.push("provider_read_failed"); }
    return { found, failures };
  }));
  const union = new Map(scans.flatMap(({ found }) => [...found]));
  const parityWarnings = [];
  const jobs = [];
  const closed = [];
  let unknown = scans.every(({ failures }) => failures.length > 0);
  let failureCount = scans.reduce((total, scan) => total + scan.failures.length, 0);
  await Promise.all([...union.entries()].map(async ([key, candidate]) => {
    if (scans.some(({ found }) => !found.has(key))) parityWarnings.push({ ...candidate, kind: "log_parity" });
    const reads = await Promise.allSettled(urls.map(async (url) => decodeJob(await read(url, "eth_call", [
      { to: candidate.escrow, data: JOBS_SELECTOR + candidate.jobId.slice(2) }, "latest",
    ]))));
    const values = reads.filter((result) => result.status === "fulfilled").map((result) => result.value);
    failureCount += reads.length - values.length;
    if (values.length === 0) { unknown = true; return; }
    const open = values.filter(({ state }) => state === 5);
    if (open.length < values.length) {
      if (open.length) parityWarnings.push({ ...candidate, kind: "state_parity" });
      closed.push(candidate);
      return;
    }
    if (open.some(({ disputedAt }) => disputedAt === 0)) { unknown = true; failureCount++; return; }
    jobs.push({ ...candidate, disputedAt: Math.min(...open.map(({ disputedAt }) => disputedAt)) });
  }));
  jobs.sort((a, b) => a.disputedAt - b.disputedAt || a.jobId.localeCompare(b.jobId));
  return { jobs, closed, parityWarnings, unknown, failureCount };
}
