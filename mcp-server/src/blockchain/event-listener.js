const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_MAX_BLOCKS_PER_QUERY = 1_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class EventListener {
  constructor(gateway, eventBus, stateStore = undefined, options = {}) {
    this.gateway = gateway;
    this.eventBus = eventBus;
    this.stateStore = stateStore;
    this.running = false;
    this.registrations = [];
    this.routingTable = new Map();
    this.eventNameIndex = new Map();
    this.blockTimestampCache = new Map();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBlocksPerQuery = options.maxBlocksPerQuery ?? DEFAULT_MAX_BLOCKS_PER_QUERY;
    this.confirmations = options.confirmations ?? 0;
    this.pollTimer = undefined;
    this.pollInFlight = false;
    this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
    this.lastBlock = undefined;
  }

  async start() {
    if (this.running || !this.gateway?.isEnabled() || !this.eventBus) {
      return;
    }

    this.running = true;
    this.attachEventHandlers();

    try {
      const head = await this.gateway.provider.getBlockNumber();
      this.lastBlock = Number(head);
    } catch (error) {
      this.publishProviderError(error);
      this.scheduleReconnect();
      return;
    }

    this.scheduleNextPoll(this.pollIntervalMs);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.registrations = [];
    this.routingTable.clear();
    this.eventNameIndex.clear();
  }

  attachEventHandlers() {
    this.registerEscrow("JobFunded", "escrow.job_funded", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.job_funded",
        args,
        payload,
        wallet: job.poster,
        wallets: [job.poster],
        job
      });
    });

    this.registerEscrow("JobClaimed", "escrow.job_claimed", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.job_claimed",
        args,
        payload,
        wallet: args.worker,
        wallets: [job.poster, args.worker],
        sessionId: buildSessionId(args.jobId, args.worker),
        job
      });
    });

    this.registerEscrow("ClaimEconomicsLocked", "escrow.claim_economics_locked", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.claim_economics_locked",
        args,
        payload,
        wallet: args.worker,
        wallets: [job.poster, args.worker],
        sessionId: buildSessionId(args.jobId, args.worker),
        job
      });
    });

    this.registerEscrow("WorkSubmitted", "escrow.work_submitted", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.work_submitted",
        args,
        payload,
        wallet: args.worker,
        wallets: [job.poster, args.worker],
        sessionId: buildSessionId(args.jobId, args.worker),
        job
      });
    });

    this.registerEscrow("JobRejected", "escrow.job_rejected", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.job_rejected",
        args,
        payload,
        wallet: normalizeAddress(job.worker),
        wallets: [job.poster, job.worker],
        sessionId: buildSessionId(args.jobId, job.worker),
        job
      });
    });

    this.registerEscrow("JobClosed", "escrow.job_closed", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      const worker = normalizeAddress(args.worker) ?? normalizeAddress(job.worker);
      return this.buildChainEvent({
        topic: "escrow.job_closed",
        args,
        payload,
        wallet: worker,
        wallets: [job.poster, worker],
        sessionId: buildSessionId(args.jobId, worker),
        job
      });
    });

    this.registerEscrow("JobReopened", "escrow.job_reopened", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.job_reopened",
        args,
        payload,
        wallet: job.poster,
        wallets: [job.poster],
        job
      });
    });

    this.registerEscrow("DisputeOpened", "escrow.dispute_opened", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.dispute_opened",
        args,
        payload,
        wallet: normalizeAddress(args.opener),
        wallets: [job.poster, job.worker, args.opener],
        sessionId: buildSessionId(args.jobId, job.worker),
        job
      });
    });

    this.registerEscrow("DisputeResolved", "escrow.dispute_resolved", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.dispute_resolved",
        args,
        payload,
        wallet: normalizeAddress(job.worker),
        wallets: [job.poster, job.worker, args.arbitrator],
        sessionId: buildSessionId(args.jobId, job.worker),
        job,
        data: {
          workerPayout: args.workerPayout.toString(),
          reasonCode: args.reasonCode,
          metadataURI: args.metadataURI
        }
      });
    });

    this.registerEscrow("AutoResolvedOnTimeout", "escrow.auto_resolved_on_timeout", async ({ args, payload }) => {
      const job = await this.readJob(args.jobId);
      return this.buildChainEvent({
        topic: "escrow.auto_resolved_on_timeout",
        args,
        payload,
        wallet: normalizeAddress(job.worker),
        wallets: [job.poster, job.worker, args.caller],
        sessionId: buildSessionId(args.jobId, job.worker),
        job,
        data: {
          workerPayout: args.workerPayout.toString(),
          reasonCode: args.reasonCode
        }
      });
    });

    this.registerEscrow("Disclosed", "content.disclosed", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "content.disclosed",
        args,
        payload,
        wallet: normalizeAddress(args.byWallet),
        wallets: [args.byWallet],
        data: {
          hash: args.hash,
          byWallet: args.byWallet,
          timestamp: args.timestamp.toString()
        }
      }));

    this.registerEscrow("AutoDisclosed", "content.auto_disclosed", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "content.auto_disclosed",
        args,
        payload,
        data: {
          hash: args.hash,
          timestamp: args.timestamp.toString()
        }
      }));

    this.registerAccount("JobStakeLocked", "account.job_stake_locked", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "account.job_stake_locked",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          asset: args.asset,
          amount: args.amount.toString()
        }
      }));

    this.registerAccount("JobStakeReleased", "account.job_stake_released", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "account.job_stake_released",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          asset: args.asset,
          amount: args.amount.toString()
        }
      }));

    this.registerAccount("JobStakeSlashed", "account.job_stake_slashed", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "account.job_stake_slashed",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          asset: args.asset,
          amount: args.amount.toString(),
          posterAmount: args.posterAmount.toString(),
          treasuryAmount: args.treasuryAmount.toString()
        }
      }));

    this.registerAccount("ClaimFeeSlashed", "account.claim_fee_slashed", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "account.claim_fee_slashed",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account, args.verifierRecipient],
        data: {
          asset: args.asset,
          amount: args.amount.toString(),
          verifierRecipient: args.verifierRecipient,
          verifierAmount: args.verifierAmount.toString(),
          treasuryAmount: args.treasuryAmount.toString()
        }
      }));

    this.registerReputation("BadgeMinted", "reputation.badge_minted", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "reputation.badge_minted",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          category: args.category,
          level: args.level.toString(),
          metadataURI: args.metadataURI
        }
      }));

    this.registerReputation("ReputationUpdated", "reputation.updated", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "reputation.updated",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          skill: args.skill.toString(),
          reliability: args.reliability.toString(),
          economic: args.economic.toString()
        }
      }));

    this.registerReputation("ReputationSlashed", "reputation.slashed", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "reputation.slashed",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          skillDelta: args.skillDelta.toString(),
          reliabilityDelta: args.reliabilityDelta.toString(),
          economicDelta: args.economicDelta.toString(),
          reasonCode: args.reasonCode,
          newSkill: args.newSkill.toString(),
          newReliability: args.newReliability.toString(),
          newEconomic: args.newEconomic.toString()
        }
      }));

    this.registerXcm("RequestQueued", "xcm.request_queued", async ({ args, payload }) =>
      this.buildChainEvent({
        topic: "xcm.request_queued",
        args,
        payload,
        wallet: args.account,
        wallets: [args.account],
        data: {
          requestId: args.requestId,
          strategyId: args.strategyId,
          kind: Number(args.kind),
          asset: args.asset,
          recipient: args.recipient,
          assets: args.assets.toString(),
          assetsRaw: args.assets.toString(),
          shares: args.shares.toString(),
          sharesRaw: args.shares.toString(),
          nonce: safeIntegerOrRaw(args.nonce),
          nonceRaw: rawIntegerString(args.nonce)
        }
      }));

    this.registerXcm("RequestPayloadStored", "xcm.request_payload_stored", async ({ args, payload }) => {
      const request = await this.gateway.getXcmRequest(args.requestId);
      return this.buildChainEvent({
        topic: "xcm.request_payload_stored",
        args,
        payload,
        wallet: request.account,
        wallets: [request.account],
        data: {
          requestId: args.requestId,
          strategyId: request.strategyId,
          kind: request.kind,
          status: request.status,
          destinationHash: args.destinationHash,
          messageHash: args.messageHash,
          refTime: safeIntegerOrRaw(args.refTime),
          refTimeRaw: rawIntegerString(args.refTime),
          proofSize: safeIntegerOrRaw(args.proofSize),
          proofSizeRaw: rawIntegerString(args.proofSize)
        }
      });
    });

    this.registerXcm("RequestDispatched", "xcm.request_dispatched", async ({ args, payload }) => {
      const request = await this.gateway.getXcmRequest(args.requestId);
      return this.buildChainEvent({
        topic: "xcm.request_dispatched",
        args,
        payload,
        wallet: request.account,
        wallets: [request.account],
        data: {
          requestId: args.requestId,
          strategyId: request.strategyId,
          kind: request.kind,
          status: request.status,
          xcmPrecompile: args.xcmPrecompile,
          destinationHash: args.destinationHash,
          messageHash: args.messageHash
        }
      });
    });

    this.registerXcm("RequestStatusUpdated", "xcm.request_status_updated", async ({ args, payload }) => {
      const request = await this.gateway.getXcmRequest(args.requestId);
      return this.buildChainEvent({
        topic: "xcm.request_status_updated",
        args,
        payload,
        wallet: request.account,
        wallets: [request.account],
        data: {
          requestId: args.requestId,
          strategyId: request.strategyId,
          kind: request.kind,
          status: Number(args.status),
          statusLabel: request.statusLabel,
          settledAssets: args.settledAssets.toString(),
          settledAssetsRaw: args.settledAssets.toString(),
          settledShares: args.settledShares.toString(),
          settledSharesRaw: args.settledShares.toString(),
          remoteRef: request.remoteRef,
          remoteRefLabel: request.remoteRefLabel,
          failureCode: request.failureCode,
          failureCodeLabel: request.failureCodeLabel
        }
      });
    });
  }

  registerEscrow(eventName, _topic, build) {
    this.register(this.gateway.escrowContract, eventName, build);
  }

  registerReputation(eventName, _topic, build) {
    this.register(this.gateway.reputationContract, eventName, build);
  }

  registerAccount(eventName, _topic, build) {
    this.register(this.gateway.accountContract, eventName, build);
  }

  registerXcm(eventName, _topic, build) {
    this.register(this.gateway.xcmWrapperContract, eventName, build);
  }

  register(contract, eventName, build) {
    if (!contract?.interface || !contract?.target) {
      return;
    }

    const fragment = contract.interface.getEvent(eventName);
    if (!fragment?.topicHash) {
      return;
    }

    const address = String(contract.target).toLowerCase();
    const topicHash = String(fragment.topicHash).toLowerCase();
    const entry = { contract, eventName, build, address, topicHash };
    this.registrations.push(entry);
    this.routingTable.set(`${address}:${topicHash}`, entry);
    this.eventNameIndex.set(eventName, entry);
  }

  scheduleNextPoll(delayMs = this.pollIntervalMs) {
    if (!this.running) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollOnce().catch((error) => this.publishProviderError(error));
    }, delayMs);
    if (typeof this.pollTimer?.unref === "function") {
      this.pollTimer.unref();
    }
  }

  async pollOnce() {
    if (!this.running || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const head = Number(await this.gateway.provider.getBlockNumber());
      const targetBlock = Math.max(0, head - this.confirmations);

      if (this.lastBlock === undefined) {
        this.lastBlock = targetBlock;
      }

      let fromBlock = this.lastBlock + 1;
      const addresses = uniqueAddresses(this.registrations);
      if (addresses.length === 0 || fromBlock > targetBlock) {
        return;
      }

      while (fromBlock <= targetBlock) {
        const chunkTo = Math.min(fromBlock + this.maxBlocksPerQuery - 1, targetBlock);
        const logs = await this.gateway.provider.getLogs({
          fromBlock,
          toBlock: chunkTo,
          address: addresses.length === 1 ? addresses[0] : addresses
        });
        sortLogs(logs);
        for (const log of logs) {
          if (!this.running) {
            return;
          }
          await this.dispatchLog(log);
        }
        this.lastBlock = chunkTo;
        fromBlock = chunkTo + 1;
      }
      this.reconnectDelayMs = MIN_RECONNECT_DELAY_MS;
    } catch (error) {
      this.publishProviderError(error);
      this.scheduleReconnect();
      return;
    } finally {
      this.pollInFlight = false;
    }
    this.scheduleNextPoll(this.pollIntervalMs);
  }

  async dispatchLog(log) {
    if (!log) {
      return;
    }
    const address = String(log.address ?? "").toLowerCase();
    const topic0 = log.topics?.[0] ? String(log.topics[0]).toLowerCase() : undefined;
    if (!address || !topic0) {
      return;
    }
    const entry = this.routingTable.get(`${address}:${topic0}`);
    if (!entry) {
      return;
    }

    let parsed;
    try {
      parsed = entry.contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data
      });
    } catch (error) {
      this.publishListenerError(entry.eventName, error);
      return;
    }
    if (!parsed) {
      return;
    }

    await this.deliver(entry, parsed.args, log);
  }

  async dispatch(eventName, args, log = {}) {
    const entry = this.eventNameIndex.get(eventName);
    if (!entry) {
      throw new Error(`no registration for event ${eventName}`);
    }
    const fullLog = {
      transactionHash: log.transactionHash ?? `0x${"00".repeat(32)}`,
      index: log.index ?? 0,
      blockNumber: log.blockNumber ?? 0n,
      address: entry.address,
      topics: log.topics ?? [entry.topicHash],
      ...log
    };
    await this.deliver(entry, args, fullLog);
  }

  async deliver(entry, args, log) {
    try {
      const payload = { args, log };
      const event = await entry.build({ args, payload });
      if (event) {
        this.eventBus.publish(event);
      }
    } catch (error) {
      this.publishListenerError(entry.eventName, error);
    }
  }

  publishListenerError(eventName, error) {
    this.eventBus.publish({
      id: `system-error-${Date.now()}`,
      topic: "system.listener_error",
      timestamp: new Date().toISOString(),
      data: {
        eventName,
        message: error?.message ?? "listener_error"
      }
    });
  }

  async readJob(jobId) {
    const job = await this.gateway.escrowContract.jobs(jobId);
    return {
      poster: normalizeAddress(job.poster),
      worker: normalizeAddress(job.worker),
      asset: job.asset,
      reward: job.reward?.toString?.() ?? `${job.reward}`,
      released: job.released?.toString?.() ?? `${job.released}`,
      claimExpiry: safeIntegerOrRaw(job.claimExpiry),
      claimExpiryRaw: rawIntegerString(job.claimExpiry),
      claimStake: job.claimStake?.toString?.() ?? `${job.claimStake}`,
      claimStakeBps: Number(job.claimStakeBps),
      claimFee: job.claimFee?.toString?.() ?? `${job.claimFee}`,
      claimFeeBps: Number(job.claimFeeBps),
      claimEconomicsWaived: Boolean(job.claimEconomicsWaived),
      rejectingVerifier: normalizeAddress(job.rejectingVerifier),
      rejectedAt: safeIntegerOrRaw(job.rejectedAt),
      rejectedAtRaw: rawIntegerString(job.rejectedAt),
      disputedAt: safeIntegerOrRaw(job.disputedAt),
      disputedAtRaw: rawIntegerString(job.disputedAt),
      state: Number(job.state)
    };
  }

  async buildChainEvent({ topic, args, payload, wallet, wallets = [], sessionId = undefined, job = undefined, data = {} }) {
    const blockNumber = Number(payload.log.blockNumber);
    const blockNumberRaw = rawIntegerString(payload.log.blockNumber);
    const timestamp = await this.getBlockTimestamp(blockNumber);
    const chainJobId = args.jobId ? normalizeJobId(args.jobId) : undefined;
    const mappedSession = chainJobId ? await this.stateStore?.findSessionByChainJobId?.(chainJobId) : undefined;
    const logicalJobId = mappedSession?.jobId ?? chainJobId;
    const resolvedSessionId = sessionId ?? mappedSession?.sessionId ?? buildSessionId(logicalJobId, job?.worker);

    return {
      id: `${payload.log.transactionHash}-${payload.log.index ?? payload.log.logIndex ?? 0}`,
      topic,
      wallet: normalizeAddress(wallet),
      wallets: wallets.map(normalizeAddress).filter(Boolean),
      jobId: logicalJobId,
      sessionId: resolvedSessionId,
      blockNumber,
      txHash: payload.log.transactionHash,
      timestamp,
      data: {
        ...serializeArgs(args),
        chainJobId,
        ...(blockNumberRaw !== undefined ? { blockNumberRaw } : {}),
        ...data,
        job
      }
    };
  }

  async getBlockTimestamp(blockNumber) {
    if (this.blockTimestampCache.has(blockNumber)) {
      return this.blockTimestampCache.get(blockNumber);
    }
    const block = await this.gateway.provider.getBlock(blockNumber);
    const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
    this.blockTimestampCache.set(blockNumber, timestamp);
    if (this.blockTimestampCache.size > 100) {
      const firstKey = this.blockTimestampCache.keys().next().value;
      this.blockTimestampCache.delete(firstKey);
    }
    return timestamp;
  }

  publishProviderError(error) {
    this.eventBus.publish({
      id: `system-provider-error-${Date.now()}`,
      topic: "system.provider_error",
      timestamp: new Date().toISOString(),
      data: {
        message: error?.message ?? "provider_error"
      }
    });
  }

  scheduleReconnect() {
    if (!this.running) {
      return;
    }
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.eventBus.publish({
      id: `system-reconnect-${Date.now()}`,
      topic: "system.reconnect",
      timestamp: new Date().toISOString(),
      data: {
        delayMs: this.reconnectDelayMs
      }
    });
    this.scheduleNextPoll(this.reconnectDelayMs);
  }
}

function uniqueAddresses(registrations) {
  const seen = new Set();
  for (const entry of registrations) {
    if (entry?.address) {
      seen.add(entry.address);
    }
  }
  return [...seen];
}

function sortLogs(logs) {
  logs.sort((a, b) => {
    const blockDiff = Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n);
    if (blockDiff !== 0) return blockDiff;
    const ai = Number(a.index ?? a.logIndex ?? 0);
    const bi = Number(b.index ?? b.logIndex ?? 0);
    return ai - bi;
  });
}

function serializeArgs(args) {
  return Object.fromEntries(
    Object.entries(args ?? {})
      .filter(([key]) => Number.isNaN(Number(key)))
      .map(([key, value]) => [key, serializeValue(value)])
  );
}

function serializeValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  return value;
}

function rawIntegerString(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "bigint") {
    return value >= 0n ? value.toString() : undefined;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  const normalized = String(value).trim();
  return /^\d+$/u.test(normalized) ? BigInt(normalized).toString() : undefined;
}

function safeIntegerNumber(value) {
  const raw = rawIntegerString(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = BigInt(raw);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(parsed);
}

function safeIntegerOrRaw(value) {
  const safe = safeIntegerNumber(value);
  return safe ?? rawIntegerString(value);
}

function normalizeAddress(address) {
  if (!address || address === ZERO_ADDRESS) {
    return undefined;
  }
  return String(address);
}

function normalizeJobId(jobId) {
  return jobId ? String(jobId) : undefined;
}

function buildSessionId(jobId, worker) {
  if (!jobId || !worker || worker === ZERO_ADDRESS) {
    return undefined;
  }
  return `${jobId}:${worker}`;
}
