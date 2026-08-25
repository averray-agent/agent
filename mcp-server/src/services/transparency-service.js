import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { getAddress } from "ethers";

import { findLatestDepositSwap } from "./bank-deposit-evidence.js";
import { describeBalanceTarget } from "./bank-lane-feed.js";
import { redactProviderError } from "../core/redact-provider-error.js";
import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { deriveH160FromAccountId32 } from "../core/wallet-identity.js";

export const TRANSPARENCY_SCHEMA_VERSION = "averray.transparency.v1";
export const TRANSPARENCY_CACHE_TTL_MS = 15_000;
export const TRANSPARENCY_FRESHNESS_WINDOWS_MS = Object.freeze({
  flow: 120_000,
  chain: 60_000,
  bank: 60_000,
  subject: 60_000
});

const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
const BASIS_POINTS_SCALE = 10_000n;
const MAX_REBASE_CORROBORATION_BPS = 2n;
const PAGE_SIZE = 250;
const MAX_RECORDS = 10_000;
const FLOW_JOIN_BATCH_SIZE = 64;
const SETTLED_SESSION_STATUSES = new Set(["resolved", "rejected", "closed"]);
const ACTIVE_ESCROW_STATES = new Set([1, 2, 3, 4, 5]);
const OWNER_RECORDS = Object.freeze({
  "420420419": new URL("../../../deployments/mainnet-multisig-owner.json", import.meta.url),
  "420420417": new URL("../../../deployments/testnet-multisig-owner.json", import.meta.url)
});

/**
 * Read-only model behind the authenticated Capital / Transparency panel.
 *
 * Chain reads are deliberately independent: one failed RPC produces one
 * unknown field and never collapses the document. A background single-flight
 * holds the latest feed readings; status is re-derived for every response, so
 * a held reading can never be presented as fresh after its evidence ages out.
 */
export class TransparencyService {
  constructor({
    bankLaneFeed,
    gateway,
    platformService,
    stateStore,
    venueBalanceReader,
    selfIdentityRegistry,
    cacheTtlMs = TRANSPARENCY_CACHE_TTL_MS,
    freshnessWindowsMs = TRANSPARENCY_FRESHNESS_WINDOWS_MS,
    now = () => Date.now(),
    treasuryIdentity = undefined,
    logger = console
  } = {}) {
    this.bankLaneFeed = bankLaneFeed;
    this.gateway = gateway;
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.venueBalanceReader = venueBalanceReader;
    this.selfIdentityRegistry = selfIdentityRegistry instanceof SelfIdentityRegistry
      ? selfIdentityRegistry
      : new SelfIdentityRegistry();
    this.cacheTtlMs = Number(cacheTtlMs);
    this.freshnessWindowsMs = normalizeFreshnessWindows(freshnessWindowsMs);
    this.minimumFreshnessWindowMs = Math.min(...Object.values(this.freshnessWindowsMs));
    this.now = now;
    this.logger = logger;
    this.heldSnapshot = undefined;
    this.refreshInFlight = undefined;
    this.refreshTimer = undefined;
    this.treasuryIdentity = treasuryIdentity ?? loadTreasuryIdentity(gateway?.config?.chainId);
    assertCacheFreshnessInvariant(this.cacheTtlMs, this.freshnessWindowsMs);
  }

  start() {
    if (this.refreshTimer) return;
    this.refreshInBackground();
    this.refreshTimer = setInterval(() => this.refreshInBackground(), this.cacheTtlMs);
    this.refreshTimer.unref?.();
  }

  stop() {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async getSnapshot() {
    const held = this.heldSnapshot;
    const nowMs = this.now();
    const heldAgeMs = held ? Math.max(0, nowMs - held.assembledAtMs) : Number.POSITIVE_INFINITY;

    if (held && heldAgeMs <= this.minimumFreshnessWindowMs) {
      if (heldAgeMs >= this.cacheTtlMs) this.refreshInBackground();
      return this.buildSnapshot(held, nowMs);
    }

    // No held reading, or one older than the smallest advertised freshness
    // window, may not take the fast path. Join the one live assembly exactly as
    // the pre-held service did instead of serving evidence beyond its bound.
    return this.buildSnapshot(await this.refresh(), this.now());
  }

  refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.assembleHeldSnapshot()
      .then((snapshot) => {
        this.heldSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
      });
    this.refreshInFlight = refresh;
    return refresh;
  }

  refreshInBackground() {
    void this.refresh().catch((error) => {
      this.logger.warn?.(
        { err: error instanceof Error ? error : new Error(String(error)) },
        "transparency.refresh_failed"
      );
    });
  }

  async assembleHeldSnapshot() {
    const assembledAtMs = this.now();
    const assemblyTimingsMs = {};
    const measure = async (name, loader) => {
      const startedAt = performance.now();
      try {
        return await loader();
      } finally {
        assemblyTimingsMs[name] = Math.max(0, Math.round(performance.now() - startedAt));
      }
    };
    const [flow, escrow, bank, treasuryBalance, chainHead] = await Promise.all([
      measure("flow", () => this.readFlow()),
      measure("escrow", () => this.readEscrow()),
      measure("bank", () => this.readBank()),
      measure("treasury-balance", () => this.readTreasuryBalance()),
      measure("chain-head", () => this.readChainHead())
    ]);
    return {
      assembledAtMs,
      assemblyTimingsMs,
      flow,
      escrow,
      bank,
      treasuryBalance,
      chainHead
    };
  }

  buildSnapshot({
    flow,
    escrow,
    bank,
    treasuryBalance,
    chainHead,
    assemblyTimingsMs
  }, generatedAtMs) {
    const subject = bank.subject;
    const generation = this.buildGeneration(subject, generatedAtMs);
    const treasuryLine = this.usdcField(treasuryBalance, "chain", generatedAtMs);
    const hydrationTotal = this.usdcField(bank.position, "bank", generatedAtMs);
    const operatingFloat = this.usdcField(bank.float, "bank", generatedAtMs);
    const positionEconomics = derivePositionEconomics({
      deposited: bank.deposited,
      positionNow: bank.position,
      committed: bank.committed,
      floatRemaining: bank.float,
      configuredWrapper: bank.configuredWrapper
    });
    const total = aggregateRawReadings(
      [treasuryBalance, bank.position, bank.float],
      {
        source: `sum(asset-hub treasury, hydration aUSDC, hydration asset-22 float) | wrapper ${bank.configuredWrapper ?? "unknown"}`,
        proof: "component proofs in treasury.lines"
      }
    );

    return {
      schemaVersion: TRANSPARENCY_SCHEMA_VERSION,
      generatedAtMs,
      readPolicy: this.buildReadPolicy(generatedAtMs, assemblyTimingsMs),
      // The head the reader was looking at. Published so a consumer can say
      // which block a figure came from instead of inferring one from a wall
      // clock — and so it degrades to `unknown` rather than to a plausible
      // number when the gateway cannot answer.
      chain: {
        head: toField(
          { ...chainHead, unit: "block" },
          { nowMs: generatedAtMs, freshnessWindowMs: this.freshnessWindowsMs.chain }
        )
      },
      flow: this.buildFlow(flow, generatedAtMs),
      escrow: {
        contractAddress: toField(escrow.contractAddress, {
          nowMs: generatedAtMs,
          freshnessWindowMs: this.freshnessWindowsMs.chain
        }),
        posterObligationsInFlight: this.usdcField(escrow.obligations, "chain", generatedAtMs),
        balanceHeldByEscrowContract: this.usdcField(escrow.balance, "chain", generatedAtMs)
      },
      treasury: {
        generation,
        totalUsdcEquivalent: this.usdcField(total, "bank", generatedAtMs),
        position: Object.fromEntries(Object.entries(positionEconomics).map(([name, reading]) => [
          name,
          this.usdcField(reading, "bank", generatedAtMs)
        ])),
        lines: {
          assetHubMultisig: {
            balance: treasuryLine,
            nativeAccountId32: toField(treasuryBalance.nativeAccountId32, {
              nowMs: generatedAtMs,
              freshnessWindowMs: this.freshnessWindowsMs.chain
            }),
            evmLens: toField(treasuryBalance.evmLens, {
              nowMs: generatedAtMs,
              freshnessWindowMs: this.freshnessWindowsMs.chain
            })
          },
          hydrationPosition: {
            total: hydrationTotal,
            principal: unknownField({
              unit: "USDC",
              readAtMs: bank.position.readAtMs,
              source: `${bank.position.source} | wrapper ${bank.configuredWrapper ?? "unknown"}`,
              proof: "principal/accrued split is not separately represented by the current adapter books"
            }, generatedAtMs, this.freshnessWindowsMs.bank),
            accruedYield: unknownField({
              unit: "USDC",
              readAtMs: bank.position.readAtMs,
              source: `${bank.position.source} | wrapper ${bank.configuredWrapper ?? "unknown"}`,
              proof: "pre-settlement rebase can fold yield into principal-shaped shares"
            }, generatedAtMs, this.freshnessWindowsMs.bank),
            note: toField({
              value: "Current accounting cannot cleanly split principal from accrued yield: pre-settlement rebase may fold yield into principal-shaped shares.",
              unit: "text",
              readAtMs: bank.position.readAtMs,
              source: `HydrationUsdcAdapter accounting | wrapper ${bank.configuredWrapper ?? "unknown"}`,
              proof: bank.position.proof
            }, {
              nowMs: generatedAtMs,
              freshnessWindowMs: this.freshnessWindowsMs.bank
            })
          },
          operatingFloat: {
            balance: operatingFloat,
            asset: toField({
              value: "Hydration asset 22",
              unit: "asset",
              readAtMs: bank.float.readAtMs,
              source: `${bank.float.source} | wrapper ${bank.configuredWrapper ?? "unknown"}`,
              proof: bank.float.proof
            }, {
              nowMs: generatedAtMs,
              freshnessWindowMs: this.freshnessWindowsMs.bank
            })
          }
        }
      }
    };
  }

  buildReadPolicy(nowMs, assemblyTimingsMs) {
    const configField = (value, unit, proof) => toField({
      value,
      unit,
      readAtMs: nowMs,
      source: "transparency_service_configuration",
      proof
    }, { nowMs, freshnessWindowMs: Number.MAX_SAFE_INTEGER });
    return {
      cacheTtl: configField(this.cacheTtlMs, "ms", "TRANSPARENCY_CACHE_TTL_MS"),
      freshnessWindows: Object.fromEntries(Object.entries(this.freshnessWindowsMs).map(([name, value]) => [
        name,
        configField(value, "ms", `TRANSPARENCY_FRESHNESS_WINDOWS_MS.${name}`)
      ])),
      assemblyTimingsMs: Object.fromEntries([
        "flow",
        "escrow",
        "bank",
        "treasury-balance",
        "chain-head"
      ].map((name) => [name, Number(assemblyTimingsMs?.[name] ?? 0)]))
    };
  }

  buildGeneration(subject, nowMs) {
    const configuredWrapper = subject.value?.configuredWrapper ?? null;
    const candidate = subject.value?.candidates?.find((entry) => sameAddress(entry.wrapper, configuredWrapper));
    const common = {
      readAtMs: subject.readAtMs,
      source: "bank_lane_feed sole-armed-wrapper subject",
      proof: subject.proof
    };
    return {
      wrapperAddress: toField({ ...common, value: configuredWrapper, unit: "address" }, {
        nowMs,
        freshnessWindowMs: this.freshnessWindowsMs.subject
      }),
      version: toField({ ...common, value: candidate?.version ?? null, unit: "generation" }, {
        nowMs,
        freshnessWindowMs: this.freshnessWindowsMs.subject
      }),
      state: toField({ ...common, value: subject.value?.status ?? null, unit: "state" }, {
        nowMs,
        freshnessWindowMs: this.freshnessWindowsMs.subject
      }),
      reason: toField({ ...common, value: subject.value?.reason ?? "none", unit: "reason" }, {
        nowMs,
        freshnessWindowMs: this.freshnessWindowsMs.subject
      })
    };
  }

  buildFlow(flow, nowMs) {
    const countField = (reading) => toField(reading, {
      nowMs,
      freshnessWindowMs: this.freshnessWindowsMs.flow
    });
    const moneyField = (reading) => this.usdcField(reading, "flow", nowMs);
    return {
      jobsSettled: {
        last24h: countField(flow.windows.last24h.jobs),
        last7d: countField(flow.windows.last7d.jobs),
        allTime: countField(flow.windows.allTime.jobs)
      },
      usdcPaid: {
        last24h: moneyField(flow.windows.last24h.paid),
        last7d: moneyField(flow.windows.last7d.paid),
        allTime: moneyField(flow.windows.allTime.paid)
      },
      composition24h: {
        platformVerificationRuns: countField(flow.composition.platformVerificationRuns),
        ingested: countField(flow.composition.ingested),
        external: countField(flow.composition.external),
        unclassified: countField(flow.composition.unclassified),
        total: countField(flow.windows.last24h.jobs)
      },
      workers24h: {
        outsiders: countField(flow.workers.outsiders),
        ours: countField(flow.workers.ours),
        unknown: countField(flow.workers.unknown),
        total: countField(flow.windows.last24h.jobs)
      },
      settledToExternalWallets24h: countField(flow.workers.outsiders),
      posterFeesAllTime: {
        external: moneyField(flow.posterFees.external),
        operatorSelfPaid: moneyField(flow.posterFees.operatorSelfPaid),
        total: moneyField(flow.posterFees.total)
      }
    };
  }

  usdcField(reading, freshnessKey, nowMs) {
    const normalized = reading?.raw === null || reading?.raw === undefined
      ? { ...reading, value: null, unit: "USDC" }
      : { ...reading, value: formatUsdcRaw(reading.raw), unit: "USDC" };
    return toField(normalized, {
      nowMs,
      freshnessWindowMs: this.freshnessWindowsMs[freshnessKey]
    });
  }

  async readFlow() {
    const readAtMs = this.now();
    const source = "backend_state_store.listRecentSessions settlement receipts";
    const proof = "/admin/sessions persisted payoutTx.settlement";
    const usdcAddress = usdcAsset(this.gateway)?.address;
    try {
      const sessions = await collectPaged((limit, offset) => this.stateStore.listRecentSessions(limit, offset));
      const settledByJob = dedupeSettledSessions(sessions);
      const definitions = new Map();
      const chainJobs = new Map();
      const settledSessions = [...settledByJob.values()];
      const [chainJobResults, fundedJobs] = await Promise.all([
        readChainJobs(this.gateway, settledSessions),
        readFundedJobs(this.stateStore, settledSessions)
      ]);
      for (let index = 0; index < settledSessions.length; index += 1) {
        const session = settledSessions[index];
        // Attribution becomes unknown when a chain read fails. A partial sum
        // would understate operator-self-paid revenue and is less honest than
        // no figure.
        chainJobs.set(
          settlementJobKey(session),
          chainJobResults[index]?.status === "fulfilled"
            ? chainJobResults[index].value
            : undefined
        );
        const fundedJob = fundedJobs[index];
        if (fundedJob?.sourceType) {
          definitions.set(session.jobId, { source: { type: fundedJob.sourceType } });
          continue;
        }
        try {
          definitions.set(session.jobId, this.platformService.getJobDefinition(session.jobId));
        } catch {
          definitions.set(session.jobId, undefined);
        }
      }
      const nowMs = this.now();
      const windows = {
        last24h: summarizeSettledWindow(settledByJob, nowMs - 24 * 60 * 60 * 1000, { readAtMs, source, proof, usdcAddress }),
        last7d: summarizeSettledWindow(settledByJob, nowMs - 7 * 24 * 60 * 60 * 1000, { readAtMs, source, proof, usdcAddress }),
        allTime: summarizeSettledWindow(settledByJob, Number.NEGATIVE_INFINITY, { readAtMs, source, proof, usdcAddress })
      };
      const last24h = [...settledByJob.values()].filter((session) => settlementTimestampMs(session) >= nowMs - 24 * 60 * 60 * 1000);
      const classified = { platformVerificationRuns: 0, ingested: 0, external: 0, unclassified: 0 };
      for (const session of last24h) {
        classified[classifySettlementSource(definitions.get(session.jobId))] += 1;
      }
      const incomplete = classified.unclassified > 0;
      const composition = Object.fromEntries(Object.entries(classified).map(([name, value]) => [
        name,
        {
          value: incomplete && name !== "unclassified" ? null : value,
          unit: "jobs",
          readAtMs,
          source: "backend_state_store sessions joined to existing funded-job source metadata",
          proof: incomplete
            ? `${classified.unclassified} settled job(s) could not be classified without guessing`
            : "stateStore.listRecentSessions + stateStore.getFundedJob(sourceType)"
        }
      ]));
      const workerCounts = { outsiders: 0, ours: 0, unknown: 0 };
      for (const session of last24h) {
        const wallet = String(session?.wallet ?? "").trim();
        if (!wallet) {
          workerCounts.unknown += 1;
          continue;
        }
        const identity = this.selfIdentityRegistry.classify({ wallet, session });
        if (identity.actor === "self") workerCounts.ours += 1;
        else if (identity.actor === "external") workerCounts.outsiders += 1;
        else workerCounts.unknown += 1;
      }
      const workers = Object.fromEntries(Object.entries(workerCounts).map(([name, value]) => [
        name,
        {
          value,
          unit: "jobs",
          readAtMs,
          source: "backend_state_store sessions classified by the shared self-identity registry",
          proof: "session.wallet + durable claimantAttribution + configured operator identity registry"
        }
      ]));
      const posterFees = summarizePosterFees(
        settledByJob,
        chainJobs,
        this.selfIdentityRegistry,
        { readAtMs, source, proof }
      );
      return { windows, composition, workers, posterFees };
    } catch (error) {
      const unknown = { value: null, raw: null, readAtMs, source, proof: redactProviderError(error) || "flow_read_failed" };
      return {
        windows: {
          last24h: { jobs: { ...unknown, unit: "jobs" }, paid: unknown },
          last7d: { jobs: { ...unknown, unit: "jobs" }, paid: unknown },
          allTime: { jobs: { ...unknown, unit: "jobs" }, paid: unknown }
        },
        composition: Object.fromEntries(
          ["platformVerificationRuns", "ingested", "external", "unclassified"].map((name) => [name, { ...unknown, unit: "jobs" }])
        ),
        workers: Object.fromEntries(
          ["outsiders", "ours", "unknown"].map((name) => [name, { ...unknown, unit: "jobs" }])
        ),
        posterFees: Object.fromEntries(
          ["external", "operatorSelfPaid", "total"].map((name) => [name, unknown])
        )
      };
    }
  }

  async readEscrow() {
    const escrowAddress = this.gateway?.config?.escrowCoreAddress;
    const token = usdcAsset(this.gateway);
    const readAtMs = this.now();
    const addressReading = escrowAddress
      ? {
          value: getAddress(escrowAddress),
          unit: "address",
          readAtMs,
          source: "blockchain configuration rendered from deployments manifest",
          proof: "deployments/mainnet.json contracts.escrowCore"
        }
      : { value: null, unit: "address", readAtMs, source: "blockchain configuration", proof: "ESCROW_CORE_ADDRESS unavailable" };

    const [balance, obligations] = await Promise.all([
      this.safeRawRead({
        source: `eth_call balanceOf ${shortAddress(token?.address)} @ asset-hub`,
        proof: `${safeEndpoint(this.gateway?.config?.rpcUrl)} token ${token?.address ?? "unknown"} account ${escrowAddress ?? "unknown"}`,
        loader: async () => {
          const result = await this.venueBalanceReader.read({
            ledger: "erc20",
            endpoint: this.gateway.config.rpcUrl,
            chainId: this.gateway.config.chainId,
            account: escrowAddress,
            contract: token.address
          });
          return { raw: result.raw, readAtMs: Date.parse(result.asOf) };
        }
      }),
      this.safeRawRead({
        source: `EscrowCore.jobs active obligations @ ${escrowAddress ?? "unknown"}`,
        proof: `${safeEndpoint(this.gateway?.config?.rpcUrl)} ${escrowAddress ?? "unknown"}`,
        loader: async () => {
          const jobs = this.platformService.listJobs({ includePaused: true, includeArchived: true, includeStale: true });
          const unique = new Map(jobs.map((job) => [job.id, job]));
          const liveJobs = await Promise.all([...unique.values()].map((job) => this.gateway.getJob(job.id)));
          let total = 0n;
          for (const live of liveJobs) {
            if (!ACTIVE_ESCROW_STATES.has(Number(live.state))) continue;
            if (!sameAddress(live.asset, token.address)) continue;
            total += remainingEscrowObligation(live);
          }
          return { raw: total, readAtMs: this.now() };
        }
      })
    ]);
    return { contractAddress: addressReading, balance, obligations };
  }

  async readTreasuryBalance() {
    const wrapper = this.gateway?.config?.xcmWrapperAddress;
    const token = usdcAsset(this.gateway);
    const identity = this.treasuryIdentity;
    const protocolFee = await this.safeValueRead({
      source: `EscrowCore.treasuryAccount() | wrapper ${wrapper ?? "unknown"}`,
      proof: `${safeEndpoint(this.gateway?.config?.rpcUrl)} ${this.gateway?.config?.escrowCoreAddress ?? "unknown"}`,
      loader: async () => ({ value: (await this.gateway.getProtocolFeeConfig()).treasuryAccount, readAtMs: this.now() })
    });
    const evmLens = protocolFee.value && identity?.evmLens && sameAddress(protocolFee.value, identity.evmLens)
      ? getAddress(protocolFee.value)
      : protocolFee.value && !identity?.evmLens
        ? getAddress(protocolFee.value)
        : null;
    const mappingValid = !identity?.nativeAccountId32
      || (evmLens && deriveH160FromAccountId32(identity.nativeAccountId32).toLowerCase() === evmLens.toLowerCase());
    const common = {
      readAtMs: protocolFee.readAtMs,
      source: `native multisig EVM lens; eth_call balanceOf ${shortAddress(token?.address)} @ asset-hub | wrapper ${wrapper ?? "unknown"}`,
      proof: `${safeEndpoint(this.gateway?.config?.rpcUrl)} native ${identity?.nativeAccountId32 ?? "unknown"} -> EVM ${evmLens ?? "unknown"}`
    };
    if (!evmLens || !mappingValid) {
      return {
        raw: null,
        ...common,
        nativeAccountId32: { value: identity?.nativeAccountId32 ?? null, unit: "accountId32", ...common },
        evmLens: { value: null, unit: "address", ...common }
      };
    }
    const balance = await this.safeRawRead({
      source: common.source,
      proof: common.proof,
      loader: async () => {
        const result = await this.venueBalanceReader.read({
          ledger: "erc20",
          endpoint: this.gateway.config.rpcUrl,
          chainId: this.gateway.config.chainId,
          account: evmLens,
          contract: token.address
        });
        return { raw: result.raw, readAtMs: Date.parse(result.asOf) };
      }
    });
    return {
      ...balance,
      nativeAccountId32: { value: identity?.nativeAccountId32 ?? null, unit: "accountId32", ...common },
      evmLens: { value: evmLens, unit: "address", ...common }
    };
  }

  async readBank() {
    const wrapper = this.gateway?.config?.xcmWrapperAddress;
    const readAtMs = this.now();
    try {
      const feed = await this.bankLaneFeed.getFeed();
      const configuredWrapper = feed?.subject?.configuredWrapper ?? wrapper;
      const positionTarget = this.bankLaneFeed?.targets?.position;
      const floatTarget = this.bankLaneFeed?.targets?.float;
      const positionExpected = isCorrectAusdcTarget(positionTarget)
        ? describeBalanceTarget(positionTarget)
        : null;
      const floatExpected = isCorrectFloatTarget(floatTarget)
        ? describeBalanceTarget(floatTarget)
        : null;
      const position = bankReading(feed?.position, positionExpected, {
        source: positionExpected
          ? `eth_call balanceOf ${shortAddress(positionTarget.contract)} @ hydration | wrapper ${configuredWrapper}`
          : `invalid aUSDC lens | wrapper ${configuredWrapper ?? "unknown"}`,
        proof: positionExpected
          ? `${safeEndpoint(positionTarget.endpoint)} contract ${positionTarget.contract} account ${positionTarget.account} truncate20 ${positionTarget.evmAccount}`
          : "aUSDC must use ERC20 balanceOf(truncate20(converted AccountId32)); ORML asset 1003 is forbidden",
        fallbackReadAtMs: readAtMs
      });
      const float = bankReading(feed?.float, floatExpected, {
        source: floatExpected
          ? `tokens.accounts(${floatTarget.account}, ${floatTarget.assetId}) @ hydration | wrapper ${configuredWrapper}`
          : `invalid asset-22 lens | wrapper ${configuredWrapper ?? "unknown"}`,
        proof: floatExpected
          ? `${safeEndpoint(floatTarget.endpoint)} Tokens.accounts(${floatTarget.account}, ${floatTarget.assetId})`
          : "operating float must use ORML Tokens.accounts asset 22",
        fallbackReadAtMs: readAtMs
      });
      const economics = await this.readPositionEconomicsEvidence({
        configuredWrapper,
        calibration: feed?.calibration,
        positionExpected
      });
      return {
        configuredWrapper,
        position,
        float,
        ...economics,
        subject: {
          value: feed?.subject ?? null,
          unit: "subject",
          readAtMs: feed?.subject?.readAtMs ?? null,
          source: "bank_lane_feed sole-armed-wrapper subject",
          proof: `configured wrapper ${configuredWrapper ?? "unknown"}`
        }
      };
    } catch (error) {
      const proof = redactProviderError(error) || "bank_feed_read_failed";
      return {
        configuredWrapper: wrapper,
        position: { raw: null, readAtMs, source: `bank_lane_feed position | wrapper ${wrapper ?? "unknown"}`, proof },
        float: { raw: null, readAtMs, source: `bank_lane_feed float | wrapper ${wrapper ?? "unknown"}`, proof },
        deposited: unknownPositionReading("deposit evidence unavailable because bank feed failed", wrapper, readAtMs, proof),
        committed: unknownPositionReading("committed capital unavailable because bank feed failed", wrapper, readAtMs, proof),
        subject: { value: null, unit: "subject", readAtMs, source: "bank_lane_feed subject", proof }
      };
    }
  }

  async readPositionEconomicsEvidence({ configuredWrapper, calibration, positionExpected }) {
    const unavailable = (label, proof) => unknownPositionReading(label, configuredWrapper, this.now(), proof);
    let deposit;
    try {
      if (typeof this.stateStore.getLatestBankXcmLegDispatchEvidence !== "function") {
        throw new Error("generation-keyed bank dispatch evidence reader is unavailable");
      }
      const event = await this.stateStore.getLatestBankXcmLegDispatchEvidence(
        configuredWrapper,
        "deposit_sell"
      );
      deposit = findLatestDepositSwap(event ? [event] : [], configuredWrapper);
      if (!deposit) {
        throw new Error("no current-generation deposit_sell Broadcast.Swapped evidence in generation-keyed store");
      }
      const calibrationRaw = calibrationMatches(
        calibration,
        positionExpected,
        configuredWrapper,
        deposit
      )
        ? parseUnsignedRaw(calibration.provenRaw)
        : null;
      assertPlausibleRebaseCorroboration("aUSDC calibration", calibrationRaw, deposit.raw);
    } catch (error) {
      const proof = redactProviderError(error) || "deposit_event_read_failed";
      return {
        deposited: unavailable("deposit event evidence", proof),
        committed: unavailable("staged adapter commitment", "deposit request identity unavailable")
      };
    }

    let wrapperRequest;
    try {
      wrapperRequest = await this.gateway.getXcmRequest(deposit.requestId);
      const settledSharesRaw = parseUnsignedRaw(wrapperRequest?.settledSharesRaw);
      if (String(wrapperRequest?.statusLabel ?? "").toLowerCase() !== "succeeded"
      ) {
        throw new Error("deposit request is not finalized as succeeded");
      }
      assertPlausibleRebaseCorroboration("finalized settledShares", settledSharesRaw, deposit.raw);
    } catch (error) {
      const proof = redactProviderError(error) || "deposit_finalization_read_failed";
      return {
        deposited: unavailable("finalized deposit evidence", proof),
        committed: unavailable("staged adapter commitment", "deposit finalization is unproved")
      };
    }

    const deposited = {
      raw: deposit.raw,
      readAtMs: this.now(),
      source: `${deposit.eventSource} + finalized observed ERC20 delta | wrapper ${configuredWrapper}`,
      proof: `${deposit.eventProof}; tx ${deposit.txHash} block ${deposit.blockNumber} event ${deposit.timestamp} request ${deposit.requestId}; finalized settledShares ${wrapperRequest.settledSharesRaw}; aUSDC calibration ${calibration.provenRaw} at Hydration block ${calibration.provenBlockNumber} @ ${calibration.provenAtMs}`
    };
    try {
      const adapterRequest = await this.gateway.getHydrationAdapterRequest(deposit.requestId, wrapperRequest);
      const committedRaw = parseUnsignedRaw(adapterRequest?.requestedAssetsRaw);
      if (committedRaw === null || Number(adapterRequest?.kind) !== 0) {
        throw new Error("deposit adapter request has no committed asset amount");
      }
      return {
        deposited,
        committed: {
          raw: committedRaw,
          readAtMs: this.now(),
          source: `HydrationUsdcAdapter.getAdapterRequest(${deposit.requestId}).requestedAssets | wrapper ${configuredWrapper}`,
          proof: `${this.gateway?.config?.hydrationUsdcAdapterAddress ?? "configured adapter"} request ${deposit.requestId}`
        }
      };
    } catch (error) {
      return {
        deposited,
        committed: unavailable("staged adapter commitment", redactProviderError(error) || "adapter_request_read_failed")
      };
    }
  }

  async readChainHead() {
    return await this.safeValueRead({
      source: "blockchain gateway head",
      proof: `${safeEndpoint(this.gateway?.config?.rpcUrl)} eth_blockNumber`,
      loader: async () => {
        const health = await this.gateway?.healthCheck();
        const blockNumber = Number(health?.blockNumber);
        // A disabled or unreachable gateway answers without a block number.
        // Throwing here routes it to the `unknown` field state, which is the
        // only honest answer — never fall back to a remembered head.
        if (!health?.ok || !Number.isFinite(blockNumber)) {
          throw new Error("gateway reported no block number");
        }
        return { value: blockNumber, readAtMs: this.now() };
      }
    });
  }

  async safeRawRead({ source, proof, loader }) {
    try {
      const result = await loader();
      return { raw: BigInt(result.raw), readAtMs: normalizeReadAt(result.readAtMs, this.now()), source, proof };
    } catch (error) {
      return { raw: null, readAtMs: this.now(), source, proof: `${proof}; ${redactProviderError(error) || "read_failed"}` };
    }
  }

  async safeValueRead({ source, proof, loader }) {
    try {
      const result = await loader();
      return { value: result.value ?? null, readAtMs: normalizeReadAt(result.readAtMs, this.now()), source, proof };
    } catch (error) {
      return { value: null, readAtMs: this.now(), source, proof: `${proof}; ${redactProviderError(error) || "read_failed"}` };
    }
  }
}

export function deriveFieldStatus({ value, readAtMs }, { nowMs, freshnessWindowMs }) {
  if (value === null || value === undefined || !Number.isFinite(readAtMs)) return "unknown";
  return Math.max(0, nowMs - readAtMs) <= freshnessWindowMs ? "fresh" : "stale";
}

export function toField(reading = {}, { nowMs = Date.now(), freshnessWindowMs } = {}) {
  const value = reading.value ?? null;
  return {
    value,
    unit: reading.unit ?? "unknown",
    status: deriveFieldStatus({ value, readAtMs: reading.readAtMs }, { nowMs, freshnessWindowMs }),
    readAtMs: Number.isFinite(reading.readAtMs) ? reading.readAtMs : null,
    source: reading.source ?? "unknown",
    proof: reading.proof ?? "unavailable"
  };
}

export function worstStatus(fields) {
  const states = fields.map((field) => field?.status ?? "unknown");
  if (states.includes("unknown")) return "unknown";
  if (states.includes("stale")) return "stale";
  return "fresh";
}

export function aggregateRawReadings(readings, { source, proof }) {
  const valid = readings.every((reading) => reading?.raw !== null && reading?.raw !== undefined);
  const readAtValues = readings.map((reading) => reading?.readAtMs).filter(Number.isFinite);
  return {
    raw: valid ? readings.reduce((sum, reading) => sum + BigInt(reading.raw), 0n) : null,
    readAtMs: readAtValues.length === readings.length ? Math.min(...readAtValues) : null,
    source,
    proof: valid ? proof : `${proof}; incomplete because one or more component reads are unknown`
  };
}

export function derivePositionEconomics({
  deposited,
  positionNow,
  committed,
  floatRemaining,
  configuredWrapper
}) {
  const wrapper = configuredWrapper ?? "unknown";
  const growth = subtractRawReadings([positionNow, deposited], {
    source: `aUSDC ERC20 positionNow - proved Broadcast.Swapped deposit | wrapper ${wrapper}`,
    proof: "real-read subtraction; no adapter-book principal or rate model"
  });
  const frictionPaid = subtractRawReadings([committed, deposited, floatRemaining], {
    source: `staged committed - proved deposit - live asset-22 float | wrapper ${wrapper}`,
    proof: "real-read subtraction; no projected fee model"
  });
  const netVsCommitted = subtractRawReadings([growth, frictionPaid], {
    source: `observed aUSDC growth - observed deployment friction | wrapper ${wrapper}`,
    proof: "real-read subtraction; no APY, annualisation, or break-even projection"
  });
  return { deposited, positionNow, growth, frictionPaid, netVsCommitted };
}

export function assertCacheFreshnessInvariant(cacheTtlMs, freshnessWindowsMs) {
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new Error("Transparency cache TTL must be a positive number.");
  }
  for (const [field, windowMs] of Object.entries(freshnessWindowsMs)) {
    if (!Number.isFinite(windowMs) || windowMs <= cacheTtlMs) {
      throw new Error(`Transparency cache TTL must be strictly shorter than ${field} freshness window.`);
    }
  }
}

export function classifySettlementSource(job) {
  const source = job?.source;
  const sourceType = typeof source === "string" ? source : source?.type;
  if (sourceType === "external") return "external";
  if (typeof sourceType === "string" && sourceType.trim() && sourceType !== "manual") return "ingested";
  if (job && typeof job === "object") return "platformVerificationRuns";
  return "unclassified";
}

export function remainingEscrowObligation(job) {
  const rewardRemaining = positiveDifference(job.rewardRaw, job.releasedRaw);
  const feeRemaining = positiveDifference(job.protocolFeeRaw ?? "0", job.protocolFeeReleasedRaw ?? "0");
  return rewardRemaining
    + feeRemaining
    + BigInt(job.opsReserveRaw ?? 0)
    + BigInt(job.contingencyReserveRaw ?? 0);
}

function summarizeSettledWindow(settledByJob, cutoffMs, context) {
  const selected = [...settledByJob.values()].filter((session) => settlementTimestampMs(session) >= cutoffMs);
  const jobs = {
    value: selected.length,
    unit: "jobs",
    readAtMs: context.readAtMs,
    source: context.source,
    proof: context.proof
  };
  const payouts = selected.map((session) => settledSessionPayoutRaw(session, context.usdcAddress));
  const missing = payouts.filter((raw) => raw === null).length;
  const raw = missing === 0 ? payouts.reduce((sum, value) => sum + value, 0n) : null;
  const txHashes = selected.map((session) => session?.payoutTx?.txHash).filter(Boolean);
  return {
    jobs,
    paid: {
      raw,
      readAtMs: context.readAtMs,
      source: context.source,
      proof: missing
        ? `${context.proof}; ${missing} settled payout receipt(s) unavailable`
        : `${context.proof}; txs ${txHashes.length ? txHashes.join(",") : "zero-pay rejections only"}`
    }
  };
}

export function summarizePosterFees(settledByJob, chainJobs, selfIdentityRegistry, context) {
  let externalRaw = 0n;
  let operatorSelfPaidRaw = 0n;
  let totalRaw = 0n;
  let unreadable = 0;

  for (const session of settledByJob.values()) {
    const job = chainJobs.get(settlementJobKey(session));
    const raw = unsignedRaw(job?.protocolFeeReleasedRaw);
    const poster = String(job?.poster ?? "").trim();
    if (raw === null || !/^0x[0-9a-fA-F]{40}$/u.test(poster)) {
      unreadable += 1;
      continue;
    }
    totalRaw += raw;
    const identity = selfIdentityRegistry.classify({ wallet: poster });
    if (identity.actor === "self") operatorSelfPaidRaw += raw;
    else externalRaw += raw;
  }

  const reading = (raw, label) => ({
    raw: unreadable === 0 ? raw : null,
    readAtMs: context.readAtMs,
    source: "EscrowCore.jobs poster + protocolFeeReleasedRaw classified by the shared self-identity registry",
    proof: unreadable
      ? `${unreadable} settled job(s) lacked readable poster-fee attribution`
      : `${context.proof}; ${label} from settled chain jobs`
  });
  return {
    external: reading(externalRaw, "external poster fees"),
    operatorSelfPaid: reading(operatorSelfPaidRaw, "operator-self-paid poster fees"),
    total: reading(totalRaw, "total poster fees")
  };
}

function unsignedRaw(value) {
  const raw = String(value ?? "");
  return /^(0|[1-9][0-9]*)$/u.test(raw) ? BigInt(raw) : null;
}

function settlementJobKey(session) {
  return String(session?.chainJobId ?? session?.jobId ?? "").toLowerCase();
}

function settledSessionPayoutRaw(session, usdcAddress) {
  if (session?.status === "rejected") return 0n;
  const settlement = session?.payoutTx?.settlement;
  if (Number(session?.payoutTx?.status) !== 1) return null;
  const assetMatches = String(settlement?.assetSymbol ?? "").toUpperCase() === "USDC"
    || sameAddress(settlement?.asset, usdcAddress);
  if (!assetMatches) return null;
  const raw = settlement?.workerAmountRaw;
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw) ? BigInt(raw) : null;
}

function dedupeSettledSessions(sessions) {
  const byJob = new Map();
  for (const session of sessions) {
    if (!SETTLED_SESSION_STATUSES.has(session?.status)) continue;
    const timestamp = settlementTimestampMs(session);
    if (!Number.isFinite(timestamp)) continue;
    const key = String(session.chainJobId ?? session.jobId ?? "").toLowerCase();
    if (!key) continue;
    const previous = byJob.get(key);
    if (!previous || settlementTimestampMs(previous) < timestamp) byJob.set(key, session);
  }
  return byJob;
}

function settlementTimestampMs(session) {
  return Date.parse(session?.resolvedAt ?? session?.rejectedAt ?? session?.closedAt ?? session?.updatedAt ?? "");
}

async function collectPaged(readPage) {
  const records = [];
  for (let offset = 0; offset < MAX_RECORDS; offset += PAGE_SIZE) {
    const page = await readPage(PAGE_SIZE, offset);
    if (!Array.isArray(page)) throw new Error("stats source returned a non-array page");
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw new Error(`stats source exceeded the ${MAX_RECORDS} record transparency bound`);
}

async function readChainJobs(gateway, sessions) {
  const jobIds = sessions.map((session) => session.chainJobId ?? session.jobId);
  if (typeof gateway?.getJobs === "function") {
    const results = await gateway.getJobs(jobIds, { batchSize: FLOW_JOIN_BATCH_SIZE });
    if (!Array.isArray(results) || results.length !== jobIds.length) {
      throw new Error("flow chain-job batch returned an invalid result count");
    }
    return results;
  }
  return allSettledInBatches(jobIds, FLOW_JOIN_BATCH_SIZE, (jobId) => gateway.getJob(jobId));
}

async function readFundedJobs(stateStore, sessions) {
  const jobIds = sessions.map((session) => session.jobId);
  if (typeof stateStore?.getFundedJobs === "function") {
    try {
      const results = await stateStore.getFundedJobs(jobIds);
      if (!Array.isArray(results) || results.length !== jobIds.length) {
        throw new Error("flow funded-job batch returned an invalid result count");
      }
      return results;
    } catch {
      // A failed stats join is represented as unclassified, never guessed.
      return jobIds.map(() => undefined);
    }
  }
  const results = await allSettledInBatches(
    jobIds,
    FLOW_JOIN_BATCH_SIZE,
    (jobId) => stateStore.getFundedJob?.(jobId)
  );
  return results.map((result) => result.status === "fulfilled" ? result.value : undefined);
}

async function allSettledInBatches(items, batchSize, loader) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.allSettled(items.slice(offset, offset + batchSize).map(loader)));
  }
  return results;
}

function bankReading(reading, expectedSource, { source, proof, fallbackReadAtMs }) {
  const sourceMatches = expectedSource && reading?.source === expectedSource;
  const raw = sourceMatches && reading?.lastError === null && /^\d+$/u.test(String(reading?.raw ?? ""))
    ? BigInt(reading.raw)
    : null;
  return {
    raw,
    readAtMs: Number.isFinite(reading?.readAtMs) ? reading.readAtMs : fallbackReadAtMs,
    source,
    proof: raw === null
      ? `${proof}; ${sourceMatches ? (reading?.lastError ?? "balance unavailable") : "stored lens does not match configured lens"}`
      : proof
  };
}

function calibrationMatches(calibration, expectedSource, configuredWrapper, deposit) {
  return Boolean(
    expectedSource
    && calibration?.provenSource === expectedSource
    && calibration?.provenRequestId === deposit?.requestId
    && sameAddress(calibration?.provenWrapperAddress, configuredWrapper)
    && calibration?.provenBlockNumber === deposit?.remoteBlockNumber
    && parseUnsignedRaw(calibration?.provenRaw) !== null
    && Number.isFinite(calibration?.provenAtMs)
  );
}

function subtractRawReadings([first, ...rest], { source, proof }) {
  const readings = [first, ...rest];
  const valid = readings.every((reading) => reading?.raw !== null && reading?.raw !== undefined);
  const readAtValues = readings.map((reading) => reading?.readAtMs).filter(Number.isFinite);
  return {
    raw: valid
      ? rest.reduce((value, reading) => value - BigInt(reading.raw), BigInt(first.raw))
      : null,
    readAtMs: readAtValues.length === readings.length ? Math.min(...readAtValues) : null,
    source,
    proof: valid ? proof : `${proof}; unknown because one or more required real reads are unavailable`
  };
}

function parseUnsignedRaw(value) {
  const normalized = String(value ?? "").replaceAll(",", "");
  return /^(0|[1-9][0-9]*)$/u.test(normalized) ? BigInt(normalized) : null;
}

function assertPlausibleRebaseCorroboration(label, corroboratedRaw, depositedRaw) {
  if (corroboratedRaw === null) {
    throw new Error(`${label} is missing or mismatched for the authoritative Broadcast.Swapped deposit`);
  }
  if (corroboratedRaw < depositedRaw) {
    throw new Error(`${label} is below the authoritative Broadcast.Swapped deposit`);
  }
  // Two basis points, rounded up to one raw unit, are deliberately generous
  // relative to single-raw rounding and short-pipeline accrual, yet remain
  // 250× smaller than the 5% protocol-fee scale. That separates plausible
  // rebase drift from a different deposit. This is a corroboration tolerance,
  // not a yield model: Broadcast.Swapped stays authoritative.
  const maximumExcess = (
    depositedRaw * MAX_REBASE_CORROBORATION_BPS + BASIS_POINTS_SCALE - 1n
  ) / BASIS_POINTS_SCALE;
  const excess = corroboratedRaw - depositedRaw;
  if (excess > maximumExcess) {
    throw new Error(`${label} exceeds the ${MAX_REBASE_CORROBORATION_BPS}-bps rebase corroboration bound`);
  }
}

function unknownPositionReading(label, wrapper, readAtMs, proof) {
  return {
    raw: null,
    readAtMs,
    source: `${label} | wrapper ${wrapper ?? "unknown"}`,
    proof
  };
}

function isCorrectAusdcTarget(target) {
  return target?.ledger === "erc20"
    && target?.accountTransform === "hydration_truncate20"
    && /^0x[a-fA-F0-9]{40}$/u.test(String(target?.contract ?? ""));
}

function isCorrectFloatTarget(target) {
  return target?.ledger === "substrate_tokens" && String(target?.assetId) === "22";
}

function unknownField(reading, nowMs, freshnessWindowMs) {
  return toField({ ...reading, value: null }, { nowMs, freshnessWindowMs });
}

function normalizeFreshnessWindows(value) {
  return Object.fromEntries(Object.entries(TRANSPARENCY_FRESHNESS_WINDOWS_MS).map(([key, fallback]) => [
    key,
    Number(value?.[key] ?? fallback)
  ]));
}

function normalizeReadAt(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function positiveDifference(total, released) {
  const difference = BigInt(total ?? 0) - BigInt(released ?? 0);
  return difference > 0n ? difference : 0n;
}

function usdcAsset(gateway) {
  return gateway?.config?.supportedAssets?.find((asset) => String(asset?.symbol).toUpperCase() === "USDC");
}

function formatUsdcRaw(raw) {
  const value = BigInt(raw);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USDC_SCALE;
  const fractional = (absolute % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/u, "");
  return fractional ? `${sign}${whole}.${fractional}` : `${sign}${whole}`;
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function shortAddress(value) {
  const text = String(value ?? "unknown");
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "endpoint unavailable";
  }
}

function loadTreasuryIdentity(chainId) {
  const recordUrl = OWNER_RECORDS[String(chainId ?? "")];
  if (!recordUrl) return undefined;
  try {
    const record = JSON.parse(readFileSync(recordUrl, "utf8"));
    return {
      nativeAccountId32: record?.multisig?.accountId32,
      evmLens: record?.multisig?.ownerEnvValue
    };
  } catch {
    return undefined;
  }
}
