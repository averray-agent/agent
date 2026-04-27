const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class EventListener {
  constructor(gateway, eventBus, stateStore = undefined) {
    this.gateway = gateway;
    this.eventBus = eventBus;
    this.stateStore = stateStore;
    this.running = false;
    this.registrations = [];
    this.blockTimestampCache = new Map();
    this.reconnectDelayMs = 1000;
    this.reconnectTimer = undefined;
    this.handleProviderError = this.handleProviderError.bind(this);
  }

  async start() {
    if (this.running || !this.gateway?.isEnabled() || !this.eventBus) {
      return;
    }

    this.running = true;
    this.attachEventHandlers();
    this.gateway.provider?.on?.("error", this.handleProviderError);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    for (const { contract, eventName, handler } of this.registrations) {
      contract.off(eventName, handler);
    }
    this.registrations = [];
    this.gateway.provider?.off?.("error", this.handleProviderError);
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
          shares: args.shares.toString(),
          nonce: Number(args.nonce)
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
          refTime: Number(args.refTime),
          proofSize: Number(args.proofSize)
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
          settledShares: args.settledShares.toString(),
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
    if (!contract?.on) {
      return;
    }
    const handler = async (...args) => {
      if (!this.running) {
        return;
      }

      try {
        const payload = args.at(-1);
        const event = await build({
          args: payload.args,
          payload
        });
        if (event) {
          this.eventBus.publish(event);
        }
      } catch (error) {
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
    };

    contract.on(eventName, handler);
    this.registrations.push({ contract, eventName, handler });
  }

  async readJob(jobId) {
    const job = await this.gateway.escrowContract.jobs(jobId);
    return {
      poster: normalizeAddress(job.poster),
      worker: normalizeAddress(job.worker),
      asset: job.asset,
      reward: job.reward?.toString?.() ?? `${job.reward}`,
      released: job.released?.toString?.() ?? `${job.released}`,
      claimExpiry: Number(job.claimExpiry),
      claimStake: job.claimStake?.toString?.() ?? `${job.claimStake}`,
      claimStakeBps: Number(job.claimStakeBps),
      claimFee: job.claimFee?.toString?.() ?? `${job.claimFee}`,
      claimFeeBps: Number(job.claimFeeBps),
      claimEconomicsWaived: Boolean(job.claimEconomicsWaived),
      rejectingVerifier: normalizeAddress(job.rejectingVerifier),
      rejectedAt: Number(job.rejectedAt),
      disputedAt: Number(job.disputedAt),
      state: Number(job.state)
    };
  }

  async buildChainEvent({ topic, args, payload, wallet, wallets = [], sessionId = undefined, job = undefined, data = {} }) {
    const blockNumber = Number(payload.log.blockNumber);
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

  handleProviderError(error) {
    if (!this.running) {
      return;
    }

    this.eventBus.publish({
      id: `system-provider-error-${Date.now()}`,
      topic: "system.provider_error",
      timestamp: new Date().toISOString(),
      data: {
        message: error?.message ?? "provider_error"
      }
    });

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      await this.stop();
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      await this.start();
      this.eventBus.publish({
        id: `system-reconnect-${Date.now()}`,
        topic: "system.reconnect",
        timestamp: new Date().toISOString(),
        data: {
          delayMs: this.reconnectDelayMs
        }
      });
    }, this.reconnectDelayMs);
  }
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
