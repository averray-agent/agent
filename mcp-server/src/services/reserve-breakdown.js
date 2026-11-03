import { id, zeroPadValue } from "ethers";

// The sweep packet is restricted to this deployed v3, never ABI fallback/v2.
export const RESERVE_ESCROW_V3 = "0xc2eb191fb75246667226a5d5db9d821f95a5f793";
export const RESERVE_V3_START_BLOCK = 19414957;
export const RESERVE_CHAIN_ID = 420420419n;
export const RESERVE_STATES = ["None", "Open", "Claimed", "Submitted", "Rejected", "Disputed", "Closed", "Cancelled"];
const RESERVED_STATES = RESERVE_STATES.slice(1, 6);
const TERMINAL_SESSIONS = new Set(["resolved", "expired", "cancelled", "closed", "failed"]);
const JOB_CREATED = id("JobCreated(bytes32,address,bytes32,address,uint256,uint8)");
const lower = (value) => String(value ?? "").toLowerCase();
const unavailable = () => ({ status: "unavailable", reason: "reserve_breakdown_not_reported", states: null, totalReservedRaw: null, chainReservedRaw: null, unexplainedReserved: null, sweepableReservedRaw: null });

export function reserveSweepAction(job, { timestamp, disputeWindow, minOpenForCancel, openMaxAgeDays = 14 }) {
  if (job.activeSession) return null;
  if (job.state === "Rejected" && job.rejectedAt > 0 && timestamp > job.rejectedAt + disputeWindow) return "finalize_rejected";
  if (job.state === "Claimed" && job.claimExpiry > 0 && timestamp > job.claimExpiry) return "timeout_claim";
  if (job.state === "Open" && job.createdAt > 0
      && timestamp >= job.createdAt + minOpenForCancel
      && (["stale", "closed"].includes(job.catalogueState) || timestamp > job.createdAt + openMaxAgeDays * 86400)) return "cancel_open";
  return null;
}

function unsigned(value) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) throw new Error("missing chain quantity");
  return BigInt(value);
}
function seconds(value) {
  const raw = unsigned(value);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsafe timestamp");
  return Number(raw);
}

/** Read-only, pinned to one finalized block. No generic gateway job fallback. */
export class ReserveChainReader {
  constructor(gateway) {
    this.gateway = gateway;
    this.ids = new Set();
    this.scannedThrough = RESERVE_V3_START_BLOCK - 1;
  }
  async read() {
    const g = this.gateway;
    if (!g?.config?.enabled || lower(g.config.escrowCoreAddress) !== RESERVE_ESCROW_V3) throw new Error("v3 unavailable");
    if (BigInt((await g.provider.getNetwork()).chainId) !== RESERVE_CHAIN_ID) throw new Error("wrong chain");
    const signer = lower(await g.signer.getAddress());
    const asset = g.config.supportedAssets.find((a) => a.symbol === "USDC" && a.decimals === 6);
    if (!asset) throw new Error("USDC unavailable");
    const block = await g.provider.getBlock("finalized");
    const blockTag = seconds(block?.number);
    const timestamp = seconds(block?.timestamp);
    if (blockTag < this.scannedThrough) throw new Error("finalized block regressed");
    // Advance the cache only after every range succeeds; retrying duplicates is harmless.
    const discovered = new Set(this.ids);
    const ranges = [];
    for (let fromBlock = this.scannedThrough + 1; fromBlock <= blockTag; fromBlock += 10000) ranges.push({ fromBlock, toBlock: Math.min(fromBlock + 9999, blockTag) });
    for (let i = 0; i < ranges.length; i += 4) {
      const pages = await Promise.all(ranges.slice(i, i + 4).map((range) => g.provider.getLogs({
        ...range, address: RESERVE_ESCROW_V3, topics: [JOB_CREATED, null, zeroPadValue(signer, 32)]
      })));
      for (const log of pages.flat()) {
        if (lower(log.address) !== RESERVE_ESCROW_V3 || log.removed) throw new Error("unexpected creation log");
        const event = g.escrowContract.interface.parseLog(log);
        if (event?.name !== "JobCreated" || lower(event.args.poster) !== signer) throw new Error("unexpected poster log");
        discovered.add(lower(event.args.jobId));
      }
    }
    this.ids = discovered;
    this.scannedThrough = blockTag;
    const overrides = { blockTag };
    const [position, disputeWindow, minOpenForCancel] = await Promise.all([
      g.accountContract.positions(signer, asset.address, overrides),
      g.escrowContract.DISPUTE_WINDOW(overrides),
      g.escrowContract.MIN_OPEN_FOR_CANCEL(overrides)
    ]);
    const jobs = [];
    const ids = [...discovered];
    for (let i = 0; i < ids.length; i += 16) {
      jobs.push(...await Promise.all(ids.slice(i, i + 16).map(async (jobId) => {
        const [job, createdAt] = await Promise.all([g.escrowContract.jobs(jobId, overrides), g.escrowContract.createdAt(jobId, overrides)]);
        const state = RESERVE_STATES[Number(job.state)];
        if (!state) throw new Error("unknown job state");
        return {
          jobId, escrowAddress: RESERVE_ESCROW_V3, poster: lower(job.poster), asset: lower(job.asset), state,
          reservedRaw: (unsigned(job.reward) + unsigned(job.protocolFee) + unsigned(job.opsReserve) + unsigned(job.contingencyReserve)).toString(),
          createdAt: seconds(createdAt), rejectedAt: seconds(job.rejectedAt), claimExpiry: seconds(job.claimExpiry)
        };
      })));
    }
    return { signer, asset: lower(asset.address), blockNumber: blockTag, timestamp, disputeWindow: seconds(disputeWindow), minOpenForCancel: seconds(minOpenForCancel), chainReservedRaw: unsigned(position.reserved).toString(), jobs };
  }
}

export class ReserveBreakdownService {
  constructor({ reader, stateStore, catalog, toJobId, openMaxAgeDays = 14 }) {
    Object.assign(this, { reader, stateStore, catalog, toJobId, openMaxAgeDays });
    if (!Number.isSafeInteger(openMaxAgeDays) || openMaxAgeDays <= 0) throw new Error("invalid reserve open max age");
  }
  async readContext() {
    const snapshot = await this.reader.read();
    const sessions = [];
    for (let offset = 0; ; offset += 100) {
      if (offset >= 10000) throw new Error("session inventory incomplete");
      const page = await this.stateStore.listRecentSessions(100, offset);
      if (!Array.isArray(page)) throw new Error("sessions unavailable");
      sessions.push(...page);
      if (page.length < 100) break;
    }
    const activeIds = new Set();
    for (const session of sessions) {
      if (TERMINAL_SESSIONS.has(session.status)) continue;
      if (session.chainJobId) activeIds.add(lower(session.chainJobId));
      if (session.jobId) activeIds.add(lower(this.toJobId(session.jobId)));
    }
    const listingStates = new Map(this.catalog.listJobs({ includePaused: true, includeArchived: true, includeStale: true, now: new Date(snapshot.timestamp * 1000) }).map((job) => [lower(this.toJobId(job.id)), job.lifecycle?.state]));
    const jobs = snapshot.jobs.filter((job) => lower(job.escrowAddress) === RESERVE_ESCROW_V3
      && lower(job.poster) === lower(snapshot.signer) && lower(job.asset) === lower(snapshot.asset)
      && RESERVED_STATES.includes(job.state)).map((job) => ({ ...job, activeSession: activeIds.has(lower(job.jobId)), catalogueState: listingStates.get(lower(job.jobId)) ?? null }));
    return { ...snapshot, jobs, openMaxAgeDays: this.openMaxAgeDays };
  }
  async getBreakdown() {
    // Share concurrent admin reads; do not serve a stale successful body on failure.
    if (!this.inflight) this.inflight = this.build().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async build() {
    try {
      const context = await this.readContext();
      const states = Object.fromEntries(RESERVED_STATES.map((state) => [state, { jobCount: 0, reservedRaw: "0", oldestAgeSeconds: null, sweepableNow: 0, sweepableReservedRaw: "0", jobs: [] }]));
      let total = 0n;
      let sweepable = 0n;
      for (const job of context.jobs) {
        const group = states[job.state];
        const amount = unsigned(job.reservedRaw);
        const action = reserveSweepAction(job, context);
        const age = context.timestamp - job.createdAt;
        if (age < 0 || job.createdAt <= 0) throw new Error("creation time unavailable");
        group.jobCount++;
        group.reservedRaw = (BigInt(group.reservedRaw) + amount).toString();
        group.oldestAgeSeconds = Math.max(group.oldestAgeSeconds ?? 0, age);
        if (action) {
          group.sweepableNow++;
          group.sweepableReservedRaw = (BigInt(group.sweepableReservedRaw) + amount).toString();
          sweepable += amount;
        }
        group.jobs.push({ jobId: job.jobId, reservedRaw: job.reservedRaw, ageSeconds: age, sweepAction: action, activeSession: job.activeSession });
        total += amount;
      }
      return { status: "ok", blockNumber: context.blockNumber, chainTimestamp: context.timestamp, states, totalReservedRaw: total.toString(), chainReservedRaw: context.chainReservedRaw, unexplainedReserved: (unsigned(context.chainReservedRaw) - total).toString(), sweepableReservedRaw: sweepable.toString(), unit: "USDC base units (6 decimals)" };
    } catch {
      return unavailable();
    }
  }
}
