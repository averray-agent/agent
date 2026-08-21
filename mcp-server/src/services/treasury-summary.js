import { formatUnits, getAddress } from "ethers";

import { redactProviderError } from "../core/redact-provider-error.js";

const ASSET_DECIMALS = 6;
const DEFAULT_CHAIN_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_OBSERVER_MAX_AGE_MS = 2 * 60_000;
const XCM_TOPICS = [
  "xcm.request_queued",
  "xcm.request_leg_dispatched",
  "xcm.outcome_observed",
  "xcm.balance_watch_succeeded",
  "xcm.balance_watch_timed_out",
  "xcm.request_status_updated",
  "xcm.request_auto_finalized",
  "xcm.request_finalize_failed"
];

export class TreasurySummaryService {
  constructor({
    creditPoolDoor,
    gateway,
    platformService,
    stateStore,
    bankLaneFeed,
    workerProgressionService,
    now = () => Date.now(),
    chainMaxAgeMs = DEFAULT_CHAIN_MAX_AGE_MS,
    observerMaxAgeMs = DEFAULT_OBSERVER_MAX_AGE_MS
  } = {}) {
    this.creditPoolDoor = creditPoolDoor;
    this.gateway = gateway;
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.bankLaneFeed = bankLaneFeed;
    this.workerProgressionService = workerProgressionService;
    this.now = now;
    this.chainMaxAgeMs = chainMaxAgeMs;
    this.observerMaxAgeMs = observerMaxAgeMs;
  }

  async getSummary(wallet) {
    const normalizedWallet = getAddress(wallet);
    const [creditLine, strategyLanes, xcmObserver, policyGate, creditInterest] = await Promise.all([
      this.#readFeed("creditLine", () => this.#creditLine(normalizedWallet)),
      this.#readFeed("strategyLanes", () => this.#strategyLanes()),
      this.#readFeed("xcmObserver", () => this.#xcmObserver()),
      this.#readFeed("policyGate", () => this.#policyGate()),
      this.#readFeed("creditInterest", () => this.#creditInterest())
    ]);
    const warnings = [creditLine, strategyLanes, xcmObserver, policyGate, creditInterest]
      .flatMap((feed) => feed.warning ? [feed.warning] : []);
    const summary = {};
    if (creditLine.available) {
      summary.borrowCapacity = creditLine.headroom;
      summary.borrowCapacityRaw = creditLine.headroomRaw;
      summary.creditUsed = creditLine.used;
      summary.creditUsedRaw = creditLine.usedRaw;
      summary.creditHeadroom = creditLine.headroom;
      summary.creditHeadroomRaw = creditLine.headroomRaw;
      summary.debt = creditLine.used;
    }
    if (strategyLanes.available) {
      summary.deployedLanes = strategyLanes.rows.length;
      summary.attentionCount = strategyLanes.rows.filter(
        (row) => row?.verdict?.status !== "ok"
      ).length;
      summary.allocated = strategyLanes.deployedCapital.amount;
    }
    return {
      schemaVersion: 1,
      wallet: normalizedWallet,
      asOf: new Date(this.now()).toISOString(),
      summary,
      creditLine: withoutWarning(creditLine),
      strategyLanes: withoutWarning(strategyLanes),
      xcmObserver: withoutWarning(xcmObserver),
      policyGate: withoutWarning(policyGate),
      creditInterest: withoutWarning(creditInterest),
      warnings
    };
  }

  async #creditInterest() {
    if (typeof this.workerProgressionService?.listCreditInterestRegistrations !== "function") {
      return unavailable("credit_interest_registry_not_configured");
    }
    return {
      available: true,
      stale: false,
      reason: "durable_worker_opt_in_records",
      registrations: await this.workerProgressionService.listCreditInterestRegistrations({ limit: 250 })
    };
  }

  async #readFeed(name, read) {
    try {
      const feed = await read();
      if (!feed.warning) return feed;
      return {
        ...feed,
        warning: {
          feed: name,
          code: feed.warning.code,
          message: feed.warning.message
        }
      };
    } catch (error) {
      const reason = `${name}_read_failed`;
      return {
        available: false,
        stale: false,
        reason,
        warning: {
          feed: name,
          code: reason,
          message: redactProviderError(error) || reason
        }
      };
    }
  }

  async #creditLine(wallet) {
    if (typeof this.creditPoolDoor?.getInfo !== "function"
      || typeof this.gateway?.getActiveCreditPoolLoans !== "function"
      || typeof this.platformService?.getAccountSummary !== "function") {
      return unavailable("credit_line_not_configured");
    }
    const [credit, account, activeCreditLoans] = await Promise.all([
      this.creditPoolDoor.getInfo(wallet),
      this.platformService.getAccountSummary(wallet),
      this.gateway.getActiveCreditPoolLoans(wallet)
    ]);
    if (credit?.available !== true) return unavailable(credit?.reason ?? "credit_pool_not_configured");
    const blockTimeMs = Number(credit.block?.timestamp) * 1_000;
    if (!Number.isFinite(blockTimeMs) || this.now() - blockTimeMs > this.chainMaxAgeMs) {
      return stale("credit_pool_block_stale", credit.block?.timestampIso);
    }
    const asset = String(credit.units?.asset?.symbol ?? "").trim();
    if (!asset) throw new Error("CreditPool response did not name its asset");
    const poolDebtRaw = exactRaw(credit.wallet?.outstanding?.raw, "CreditPool outstanding debt");
    const enumeratedDebtRaw = activeCreditLoans.reduce(
      (total, loan) => total + exactRaw(loan.outstandingRaw, `loan ${loan.loanId} outstanding`),
      0n
    );
    if (enumeratedDebtRaw !== poolDebtRaw) {
      throw new Error("CreditPool active-loan enumeration does not reconcile to outstandingDebt");
    }
    const accountDebt = account?.raw?.debtOutstanding;
    if (!accountDebt || typeof accountDebt !== "object" || !Object.hasOwn(accountDebt, asset)) {
      throw new Error(`AgentAccountCore did not emit ${asset} debtOutstanding`);
    }
    const accountDebtRaw = exactRaw(accountDebt[asset], `AgentAccountCore ${asset} debtOutstanding`);
    const headroomRaw = exactRaw(credit.wallet?.loanable?.raw, "CreditPool loanable capacity");
    const usedRaw = poolDebtRaw + accountDebtRaw;
    const totalRaw = usedRaw + headroomRaw;
    const activeLoans = activeCreditLoans.map((loan) => ({
      id: loan.loanId,
      source: "CreditPool.loans",
      amount: display(loan.outstandingRaw),
      amountRaw: String(loan.outstandingRaw),
      asset,
      status: "active",
      blockNumber: loan.blockNumber
    }));
    if (accountDebtRaw > 0n) {
      activeLoans.push({
        id: `aac-${asset.toLowerCase()}-debt`,
        source: "AgentAccountCore.positions.debtOutstanding",
        amount: display(accountDebtRaw),
        amountRaw: accountDebtRaw.toString(),
        asset,
        status: "active"
      });
    }
    return {
      available: true,
      stale: false,
      reason: "live_credit_pool_and_aac_reads",
      source: {
        capacity: "CreditPoolDoor.capacityReader",
        debt: ["CreditPool.outstandingDebt", "AgentAccountCore.positions.debtOutstanding"],
        loans: "CreditPool LoanOriginated/LoanClosed index + loans() live reads"
      },
      block: credit.block,
      asset,
      borrowCapacity: display(headroomRaw),
      borrowCapacityRaw: headroomRaw.toString(),
      used: display(usedRaw),
      usedRaw: usedRaw.toString(),
      headroom: display(headroomRaw),
      headroomRaw: headroomRaw.toString(),
      total: display(totalRaw),
      totalRaw: totalRaw.toString(),
      schedule: credit.schedule,
      activeLoans
    };
  }

  async #strategyLanes() {
    if (typeof this.gateway?.getTreasuryStrategyLanes !== "function") {
      return unavailable("strategy_lane_reader_not_configured");
    }
    const lanes = await this.gateway.getTreasuryStrategyLanes();
    if (lanes?.available !== true) return unavailable(lanes?.reason ?? "strategy_lanes_unavailable");
    const blockTimeMs = Number(lanes.block?.timestamp) * 1_000;
    if (!Number.isFinite(blockTimeMs) || this.now() - blockTimeMs > this.chainMaxAgeMs) {
      return stale("strategy_lane_block_stale", lanes.block?.timestampIso);
    }
    if (!Array.isArray(lanes.rows) || lanes.rows.length === 0) {
      return unavailable("strategy_registry_empty");
    }
    const assets = new Set(lanes.rows.map((row) => String(row.asset).toLowerCase()));
    if (assets.size > 1) {
      throw new Error("Strategy lane allocations use different assets and cannot be combined");
    }
    const deployedCapitalAsset = String(lanes.deployedCapital?.asset ?? "").toLowerCase();
    if (!deployedCapitalAsset || !assets.has(deployedCapitalAsset)) {
      throw new Error("DepositPool deployed capital does not match the strategy lane asset");
    }
    const totalRaw = lanes.rows.reduce(
      (total, row) => total + exactRaw(row.allocationRaw, `strategy ${row.strategyId} allocation`),
      0n
    );
    const rows = lanes.rows.map((row) => {
      const allocationRaw = exactRaw(row.allocationRaw, `strategy ${row.strategyId} allocation`);
      return {
        ...row,
        deploymentShareBps: totalRaw > 0n ? Number(allocationRaw * 10_000n / totalRaw) : 0
      };
    });
    const deployedCapitalRaw = exactRaw(
      lanes.deployedCapital?.amountRaw,
      "DepositPool deployed capital"
    );
    return {
      available: true,
      stale: false,
      reason: "wrapper_registry_live",
      source: "XcmWrapper.strategyAdapter live reads",
      wrapper: lanes.wrapper,
      block: lanes.block,
      deployedCapital: {
        ...lanes.deployedCapital,
        amount: display(deployedCapitalRaw),
        amountRaw: deployedCapitalRaw.toString()
      },
      rows
    };
  }

  async #xcmObserver() {
    if (typeof this.bankLaneFeed?.getFeed !== "function" || typeof this.stateStore?.listEventLog !== "function") {
      return unavailable("xcm_observer_feed_not_configured");
    }
    const board = await this.bankLaneFeed.getFeed();
    const requests = board?.requests;
    if (requests?.lastError) {
      return warnedUnavailable("xcm_observer_snapshot_unreadable", requests.lastError);
    }
    const readAtMs = Number(requests?.readAtMs);
    if (!Number.isFinite(readAtMs)) return unavailable("xcm_observer_quiet");
    if (this.now() - readAtMs > this.observerMaxAgeMs) {
      return stale("xcm_observer_snapshot_stale", new Date(readAtMs).toISOString());
    }
    const requestIds = new Set((requests.items ?? []).map((item) => String(item.id).toLowerCase()));
    if (requestIds.size === 0) return unavailable("xcm_observer_quiet");
    const replay = await this.stateStore.listEventLog({ topics: XCM_TOPICS, limit: 500 });
    const rows = (replay.events ?? [])
      .map(xcmRowFromEvent)
      .filter((row) => row && requestIds.has(row.requestId.toLowerCase()));
    if (rows.length === 0) {
      return warnedUnavailable(
        "xcm_observer_evidence_missing",
        "Observer requests exist without matching indexed lifecycle events."
      );
    }
    return {
      available: true,
      stale: false,
      reason: "indexed_observer_evidence_live",
      source: "bank-lane-feed requests + durable event log",
      asOf: new Date(readAtMs).toISOString(),
      rows
    };
  }

  async #policyGate() {
    if (typeof this.gateway?.getTreasuryPolicyStatus !== "function") {
      return unavailable("treasury_policy_reader_not_configured");
    }
    const policy = await this.gateway.getTreasuryPolicyStatus();
    if (policy?.enabled !== true) return unavailable("treasury_policy_not_configured");
    if ((policy.readErrors ?? []).length > 0) {
      return warnedUnavailable(
        "treasury_policy_read_incomplete",
        `TreasuryPolicy read failed for ${(policy.readErrors ?? []).map((entry) => entry.field).join(", ")}.`
      );
    }
    return {
      available: true,
      stale: false,
      reason: policy.paused ? "treasury_policy_paused" : "treasury_policy_live",
      source: "TreasuryPolicy live reads",
      policyAddress: policy.policyAddress,
      paused: policy.paused,
      asOf: new Date(this.now()).toISOString(),
      rows: policyRows(policy)
    };
  }
}

function xcmRowFromEvent(event) {
  const requestId = String(event?.data?.requestId ?? event?.correlationId ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(requestId)) return undefined;
  const topic = String(event.topic ?? "");
  const common = {
    requestId,
    leg: Number.isInteger(Number(event?.data?.leg)) ? Number(event.data.leg) : null,
    blockNumber: Number.isSafeInteger(Number(event.blockNumber)) ? Number(event.blockNumber) : null,
    timestamp: event.timestamp,
    topic
  };
  const failureReason = String(
    event?.data?.failureCodeLabel
      ?? event?.data?.failureCode
      ?? event?.data?.message
      ?? ""
  ).trim();
  if (topic === "xcm.request_queued") return { ...common, stage: "request", status: "queued" };
  if (topic === "xcm.request_leg_dispatched") return { ...common, stage: "request", status: "dispatched" };
  if (topic === "xcm.outcome_observed" || topic.startsWith("xcm.balance_watch_")) {
    return {
      ...common,
      stage: "observe",
      status: String(event?.data?.status ?? event?.phase ?? "observed"),
      ...(failureReason ? { reason: failureReason } : {})
    };
  }
  if (topic === "xcm.request_status_updated" || topic === "xcm.request_auto_finalized") {
    return {
      ...common,
      stage: "settle",
      status: String(event?.data?.statusLabel ?? event?.data?.status ?? "settled"),
      ...(failureReason ? { reason: failureReason } : {})
    };
  }
  if (topic === "xcm.request_finalize_failed") {
    return { ...common, stage: "settle", status: "error", reason: failureReason || "finalization failed" };
  }
  return undefined;
}

function policyRows(policy) {
  const roles = policy.roles ?? {};
  const rows = [
    roleRow("OWNER", "Treasury owner", policy.owner, true, "TreasuryPolicy.owner"),
    roleRow("PAUSER", "Emergency pauser", policy.pauser, Boolean(policy.pauser), "TreasuryPolicy.pauser")
  ];
  if (roles.signerAddress) {
    rows.push(
      roleRow("VERIFIER", "Settlement signer · verifier", roles.signerAddress, roles.signerIsVerifier, "TreasuryPolicy.verifiers"),
      roleRow("SETTLEMENT", "Settlement signer · broker", roles.signerAddress, roles.signerIsSettlementBroker, "TreasuryPolicy.settlementBroker"),
      roleRow("STRATEGY", "Settlement signer · strategy settler", roles.signerAddress, roles.signerIsStrategySettler, "TreasuryPolicy.strategySettler")
    );
  }
  if (roles.arbitratorSignerAddress) {
    rows.push(roleRow(
      "ARBITRATOR",
      "Arbitrator signer",
      roles.arbitratorSignerAddress,
      roles.arbitratorSignerIsArbitrator,
      "TreasuryPolicy.arbitrators"
    ));
  }
  const risk = policy.risk ?? {};
  rows.push(
    capRow("OUTFLOW", "Daily outflow cap", risk.dailyOutflowCapRaw, "asset base units", "TreasuryPolicy.dailyOutflowCap"),
    capRow("BORROW", "Per-account borrow cap", risk.perAccountBorrowCapRaw, "asset base units", "TreasuryPolicy.perAccountBorrowCap"),
    capRow("COLLATERAL", "Minimum collateral ratio", risk.minimumCollateralRatioBpsRaw, "bps", "TreasuryPolicy.minimumCollateralRatioBps")
  );
  return rows.filter(Boolean);
}

function roleRow(tag, name, address, approved, source) {
  if (!address) return undefined;
  return { tag, name, kind: "role", address, approved: Boolean(approved), source };
}

function capRow(tag, name, raw, unit, source) {
  if (!/^(0|[1-9][0-9]*)$/u.test(String(raw ?? ""))) return undefined;
  return { tag, name, kind: "cap", valueRaw: String(raw), unit, source };
}

function display(raw) {
  return Number(formatUnits(exactRaw(raw, "asset amount"), ASSET_DECIMALS));
}

function exactRaw(raw, label) {
  const value = String(raw ?? "");
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is not an exact raw integer`);
  return BigInt(value);
}

function unavailable(reason) {
  return { available: false, stale: false, reason };
}

function warnedUnavailable(code, message) {
  return {
    available: false,
    stale: false,
    reason: code,
    warning: { code, message: String(message) }
  };
}

function stale(reason, asOf) {
  return {
    available: false,
    stale: true,
    reason,
    asOf,
    warning: { code: reason, message: `Feed is stale${asOf ? ` as of ${asOf}` : ""}.` }
  };
}

function withoutWarning({ warning: _warning, ...feed }) {
  return feed;
}
