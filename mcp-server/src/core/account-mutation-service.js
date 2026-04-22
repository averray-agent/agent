import {
  BorrowCapacityExceededError,
  ConflictError,
  InsufficientLiquidityError,
  ValidationError
} from "./errors.js";

export class AccountMutationService {
  constructor(accounts, blockchainGateway = undefined, getAccountSummary) {
    this.accounts = accounts;
    this.blockchainGateway = blockchainGateway;
    this.getAccountSummary = getAccountSummary;
  }

  getStoredAccount(wallet) {
    const existing = this.accounts.get(wallet);
    if (existing) {
      this.ensureTreasuryMetadata(existing);
      return existing;
    }

    const created = {
      wallet,
      liquid: {},
      reserved: {},
      strategyAllocated: {},
      strategyShares: {},
      strategyActivity: {},
      strategyPending: {},
      strategyAccounting: {},
      treasuryTimeline: [],
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    };
    this.accounts.set(wallet, created);
    return created;
  }

  ensureTreasuryMetadata(account) {
    account.strategyShares = account.strategyShares ?? {};
    account.strategyActivity = account.strategyActivity ?? {};
    account.strategyPending = account.strategyPending ?? {};
    account.strategyAccounting = account.strategyAccounting ?? {};
    account.treasuryTimeline = account.treasuryTimeline ?? [];
    return account;
  }

  attachStoredTreasuryMetadata(wallet, liveAccount = {}) {
    const stored = this.getStoredAccount(wallet);
    return this.ensureTreasuryMetadata({
      ...liveAccount,
      strategyShares: {
        ...(liveAccount.strategyShares ?? {}),
        ...(stored.strategyShares ?? {})
      },
      strategyActivity: {
        ...(liveAccount.strategyActivity ?? {}),
        ...(stored.strategyActivity ?? {})
      },
      strategyPending: {
        ...(liveAccount.strategyPending ?? {}),
        ...(stored.strategyPending ?? {})
      },
      strategyAccounting: {
        ...(liveAccount.strategyAccounting ?? {}),
        ...(stored.strategyAccounting ?? {})
      },
      treasuryTimeline: [...(stored.treasuryTimeline ?? [])]
    });
  }

  getStrategyAccounting(account, strategyId, asset = "DOT") {
    this.ensureTreasuryMetadata(account);
    account.strategyAccounting[strategyId] = account.strategyAccounting[strategyId] ?? {
      asset,
      principal: 0,
      realizedYield: 0,
      markValue: 0,
      sharePrice: undefined,
      markedAt: undefined
    };
    if (!account.strategyAccounting[strategyId].asset) {
      account.strategyAccounting[strategyId].asset = asset;
    }
    return account.strategyAccounting[strategyId];
  }

  getStrategyPending(account, strategyId, asset = "DOT") {
    this.ensureTreasuryMetadata(account);
    account.strategyPending[strategyId] = account.strategyPending[strategyId] ?? {
      asset,
      pendingDepositAssets: 0,
      pendingWithdrawalShares: 0,
      lastRequestId: undefined,
      lastStatus: undefined,
      lastKind: undefined,
      updatedAt: undefined
    };
    if (!account.strategyPending[strategyId].asset) {
      account.strategyPending[strategyId].asset = asset;
    }
    return account.strategyPending[strategyId];
  }

  recordTreasuryEvent(account, event) {
    this.ensureTreasuryMetadata(account);
    const timeline = account.treasuryTimeline;
    timeline.unshift({
      id: `treasury-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...event
    });
    if (timeline.length > 40) {
      timeline.length = 40;
    }
  }

  updateStrategyAccountingOnAllocate(account, strategyId, asset, amount) {
    const entry = this.getStrategyAccounting(account, strategyId, asset);
    entry.principal = Number(entry.principal ?? 0) + amount;
    entry.markValue = Number(entry.markValue ?? 0) + amount;
    entry.markedAt = new Date().toISOString();
    this.recordTreasuryEvent(account, {
      type: "allocate",
      strategyId,
      asset,
      amount,
      principalAfter: entry.principal
    });
  }

  updateStrategyAccountingOnDeallocate(account, strategyId, asset, assetsReturned) {
    const entry = this.getStrategyAccounting(account, strategyId, asset);
    const principalBefore = Number(entry.principal ?? 0);
    const markValueBefore = Number(entry.markValue ?? principalBefore ?? 0);
    const denominator = Math.max(markValueBefore, assetsReturned, 0);
    const principalReleased = denominator > 0
      ? Math.min(principalBefore, principalBefore * (assetsReturned / denominator))
      : Math.min(principalBefore, assetsReturned);
    const realizedYieldDelta = assetsReturned - principalReleased;

    entry.principal = Math.max(principalBefore - principalReleased, 0);
    entry.realizedYield = Number(entry.realizedYield ?? 0) + realizedYieldDelta;
    entry.markValue = Math.max(markValueBefore - assetsReturned, 0);
    entry.markedAt = new Date().toISOString();

    this.recordTreasuryEvent(account, {
      type: "deallocate",
      strategyId,
      asset,
      amount: assetsReturned,
      realizedYieldDelta,
      principalAfter: entry.principal
    });
  }

  async recordStrategySnapshots(wallet, snapshots = []) {
    const account = this.getStoredAccount(wallet);
    this.ensureTreasuryMetadata(account);

    for (const snapshot of snapshots) {
      const strategyId = snapshot?.strategyId;
      if (!strategyId) continue;

      const asset = snapshot.assetSymbol ?? snapshot.asset ?? "DOT";
      const currentValue = Number(snapshot.currentValue ?? snapshot.routedAmount ?? 0);
      const shares = Number(snapshot.shares ?? snapshot.shareCount ?? 0);
      const sharePrice = Number(snapshot.sharePrice);
      const recordedAt = snapshot.recordedAt ?? new Date().toISOString();
      const entry = this.getStrategyAccounting(account, strategyId, asset);
      const previousValue = Number(entry.markValue ?? 0);
      const hasPriorMark = Boolean(entry.markedAt);
      const delta = currentValue - previousValue;

      if (shares > 0 && hasPriorMark && Math.abs(delta) >= 0.01) {
        this.recordTreasuryEvent(account, {
          type: "yield_mark",
          strategyId,
          asset,
          amount: currentValue,
          yieldDelta: delta,
          sharePrice: Number.isFinite(sharePrice) ? sharePrice : undefined
        });
      }

      entry.asset = asset;
      entry.markValue = currentValue;
      entry.markedAt = recordedAt;
      if (Number.isFinite(sharePrice)) {
        entry.sharePrice = sharePrice;
      }
    }

    this.accounts.set(wallet, account);
    return account.treasuryTimeline;
  }

  async recordTreasuryMutation(wallet, event) {
    const account = this.getStoredAccount(wallet);
    this.recordTreasuryEvent(account, event);
    this.accounts.set(wallet, account);
    return account.treasuryTimeline;
  }

  async reserveForJob(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.reserveForJob(wallet, asset, amount);
    }

    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[asset] ?? 0;
    if (liquid < amount) {
      throw new InsufficientLiquidityError(asset);
    }

    account.liquid[asset] = liquid - amount;
    account.reserved[asset] = (account.reserved[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async lockJobStake(wallet, asset, amount, posterWallet = undefined) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.getAccountSummary(wallet);
    }

    if (amount <= 0) {
      return this.getAccountSummary(wallet);
    }

    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[asset] ?? 0;
    if (liquid < amount) {
      throw new InsufficientLiquidityError(asset, {
        wallet,
        required: amount,
        available: liquid,
        posterWallet
      });
    }

    account.liquid[asset] = liquid - amount;
    account.jobStakeLocked[asset] = (account.jobStakeLocked[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async releaseJobStake(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.getAccountSummary(wallet);
    }

    if (amount <= 0) {
      return this.getAccountSummary(wallet);
    }

    const account = await this.getAccountSummary(wallet);
    const locked = account.jobStakeLocked[asset] ?? 0;
    if (locked < amount) {
      throw new ConflictError(`Release amount exceeds locked stake for ${asset}`, "stake_release_exceeds_locked");
    }

    account.jobStakeLocked[asset] = locked - amount;
    account.liquid[asset] = (account.liquid[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async slashJobStake(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.getAccountSummary(wallet);
    }

    if (amount <= 0) {
      return this.getAccountSummary(wallet);
    }

    const account = await this.getAccountSummary(wallet);
    const locked = account.jobStakeLocked[asset] ?? 0;
    if (locked < amount) {
      throw new ConflictError(`Slash amount exceeds locked stake for ${asset}`, "stake_slash_exceeds_locked");
    }

    account.jobStakeLocked[asset] = locked - amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async allocateIdleFunds(wallet, asset, amount, strategyId = "default-low-risk") {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    if (this.blockchainGateway?.isEnabled()) {
      const liveAccount = await this.blockchainGateway.allocateIdleFunds(wallet, strategyId, amount);
      const account = this.attachStoredTreasuryMetadata(wallet, liveAccount);
      this.markStrategyActivity(account, strategyId, "allocate", amount, asset);
      this.updateStrategyAccountingOnAllocate(account, strategyId, asset, amount);
      this.accounts.set(wallet, account);
      return account;
    }

    const account = await this.getAccountSummary(wallet);
    this.ensureTreasuryMetadata(account);
    const liquid = account.liquid[asset] ?? 0;
    if (liquid < amount) {
      throw new InsufficientLiquidityError(asset);
    }

    account.liquid[asset] = liquid - amount;
    account.strategyAllocated[asset] = (account.strategyAllocated[asset] ?? 0) + amount;
    account.strategyShares[strategyId] = (account.strategyShares[strategyId] ?? 0) + amount;
    this.markStrategyActivity(account, strategyId, "allocate", amount, asset);
    this.updateStrategyAccountingOnAllocate(account, strategyId, asset, amount);
    this.accounts.set(wallet, account);
    return account;
  }

  async requestStrategyDeposit(wallet, asset, amount, strategyId = "default-low-risk", strategy = {}, options = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    if (strategy.executionMode !== "async_xcm") {
      return this.allocateIdleFunds(wallet, asset, amount, strategyId);
    }
    if (!this.blockchainGateway?.isEnabled()) {
      throw new ValidationError("Async strategy requests require the blockchain gateway.");
    }

    const liveAccount = await this.blockchainGateway.requestStrategyDeposit(wallet, strategy, amount, options);
    const account = this.attachStoredTreasuryMetadata(wallet, liveAccount);
    const pending = this.getStrategyPending(account, strategyId, asset);
    pending.pendingDepositAssets = Number(pending.pendingDepositAssets ?? 0) + Number(liveAccount?.xcmRequest?.requestedAssets ?? amount);
    pending.lastRequestId = liveAccount?.requestId;
    pending.lastStatus = liveAccount?.xcmRequest?.statusLabel ?? "pending";
    pending.lastKind = "deposit";
    pending.updatedAt = new Date().toISOString();
    this.markStrategyActivity(account, strategyId, "allocate_requested", amount, asset);
    this.recordTreasuryEvent(account, {
      type: "allocate_requested",
      strategyId,
      asset,
      amount,
      requestId: liveAccount?.requestId
    });
    this.accounts.set(wallet, account);
    return {
      ...account,
      requestId: liveAccount?.requestId,
      xcmRequest: liveAccount?.xcmRequest,
      strategyRequest: liveAccount?.strategyRequest
    };
  }

  async deallocateIdleFunds(wallet, asset, amount, strategyId = "default-low-risk") {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    if (this.blockchainGateway?.isEnabled()) {
      const liveAccount = await this.blockchainGateway.deallocateIdleFunds(wallet, strategyId, amount, asset);
      const assetsReturned = Number(liveAccount?.returnedAmount ?? amount);
      const account = this.attachStoredTreasuryMetadata(wallet, liveAccount);
      this.markStrategyActivity(account, strategyId, "deallocate", assetsReturned, asset);
      this.updateStrategyAccountingOnDeallocate(account, strategyId, asset, assetsReturned);
      this.accounts.set(wallet, account);
      return account;
    }

    const account = await this.getAccountSummary(wallet);
    this.ensureTreasuryMetadata(account);
    const allocated = account.strategyAllocated[asset] ?? 0;
    const strategyShares = account.strategyShares;
    const currentShares = strategyShares[strategyId] ?? 0;
    if (allocated < amount || currentShares < amount) {
      throw new ConflictError(`Deallocate amount exceeds routed funds for ${asset}`, "deallocate_exceeds_allocated");
    }

    account.strategyAllocated[asset] = allocated - amount;
    account.liquid[asset] = (account.liquid[asset] ?? 0) + amount;
    account.strategyShares = strategyShares;
    account.strategyShares[strategyId] = currentShares - amount;
    this.markStrategyActivity(account, strategyId, "deallocate", amount, asset);
    this.updateStrategyAccountingOnDeallocate(account, strategyId, asset, amount);
    this.accounts.set(wallet, account);
    return account;
  }

  async requestStrategyWithdraw(wallet, asset, amount, strategyId = "default-low-risk", strategy = {}, options = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    if (strategy.executionMode !== "async_xcm") {
      return this.deallocateIdleFunds(wallet, asset, amount, strategyId);
    }
    if (!this.blockchainGateway?.isEnabled()) {
      throw new ValidationError("Async strategy requests require the blockchain gateway.");
    }

    const liveAccount = await this.blockchainGateway.requestStrategyWithdraw(wallet, strategy, amount, options);
    const account = this.attachStoredTreasuryMetadata(wallet, liveAccount);
    const pending = this.getStrategyPending(account, strategyId, asset);
    pending.pendingWithdrawalShares = Number(pending.pendingWithdrawalShares ?? 0) + Number(
      liveAccount?.strategyRequest?.requestedShares ??
      liveAccount?.xcmRequest?.requestedShares ??
      liveAccount?.requestedShares ??
      amount
    );
    pending.lastRequestId = liveAccount?.requestId;
    pending.lastStatus = liveAccount?.xcmRequest?.statusLabel ?? "pending";
    pending.lastKind = "withdraw";
    pending.updatedAt = new Date().toISOString();
    this.markStrategyActivity(account, strategyId, "deallocate_requested", amount, asset);
    this.recordTreasuryEvent(account, {
      type: "deallocate_requested",
      strategyId,
      asset,
      amount,
      requestedShares: pending.pendingWithdrawalShares,
      requestId: liveAccount?.requestId
    });
    this.accounts.set(wallet, account);
    return {
      ...account,
      requestId: liveAccount?.requestId,
      requestedShares: liveAccount?.requestedShares,
      xcmRequest: liveAccount?.xcmRequest,
      strategyRequest: liveAccount?.strategyRequest
    };
  }

  markStrategyActivity(account, strategyId, action, amount, asset) {
    this.ensureTreasuryMetadata(account);
    account.strategyActivity[strategyId] = {
      action,
      amount,
      asset,
      at: new Date().toISOString()
    };
  }

  async recordAsyncStrategySettlement(result = {}) {
    const wallet = result?.strategyRequest?.account ?? result?.account;
    const strategyId = result?.strategyRequest?.strategyId;
    const asset = result?.strategyRequest?.assetSymbol;
    if (!wallet || !strategyId || !asset) {
      return result;
    }

    const account = this.attachStoredTreasuryMetadata(wallet, await this.getAccountSummary(wallet));
    const pending = this.getStrategyPending(account, strategyId, asset);
    const kind = result?.strategyRequest?.kindLabel;
    const status = result?.strategyRequest?.statusLabel ?? result?.statusLabel ?? "unknown";
    const requestedAssets = Number(result?.strategyRequest?.requestedAssets ?? 0);
    const requestedShares = Number(result?.strategyRequest?.requestedShares ?? 0);
    const settledAssets = Number(result?.strategyRequest?.settledAssets ?? result?.settledAssets ?? 0);

    if (kind === "deposit") {
      pending.pendingDepositAssets = Math.max(Number(pending.pendingDepositAssets ?? 0) - requestedAssets, 0);
      if (status === "succeeded") {
        this.updateStrategyAccountingOnAllocate(account, strategyId, asset, settledAssets || requestedAssets);
      } else {
        this.recordTreasuryEvent(account, {
          type: "allocate_failed",
          strategyId,
          asset,
          amount: requestedAssets,
          requestId: result?.requestId,
          failureCode: result?.strategyRequest?.failureCodeLabel ?? result?.failureCodeLabel
        });
      }
    } else if (kind === "withdraw") {
      pending.pendingWithdrawalShares = Math.max(Number(pending.pendingWithdrawalShares ?? 0) - requestedShares, 0);
      if (status === "succeeded") {
        this.updateStrategyAccountingOnDeallocate(account, strategyId, asset, settledAssets);
      } else {
        this.recordTreasuryEvent(account, {
          type: "deallocate_failed",
          strategyId,
          asset,
          amount: settledAssets || requestedAssets,
          requestedShares,
          requestId: result?.requestId,
          failureCode: result?.strategyRequest?.failureCodeLabel ?? result?.failureCodeLabel
        });
      }
    }

    pending.lastRequestId = result?.requestId;
    pending.lastStatus = status;
    pending.lastKind = kind;
    pending.updatedAt = new Date().toISOString();
    this.accounts.set(wallet, account);
    return account;
  }

  async getBorrowCapacity(wallet, asset) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.getBorrowCapacity(wallet, asset);
    }

    const account = await this.getAccountSummary(wallet);
    const collateral = account.collateralLocked[asset] ?? 0;
    const debt = account.debtOutstanding[asset] ?? 0;
    return Math.max((collateral / 1.5) - debt, 0);
  }

  async borrow(wallet, asset, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    const capacity = await this.getBorrowCapacity(wallet, asset);
    if (capacity < amount) {
      throw new BorrowCapacityExceededError(asset);
    }

    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.borrow(asset, amount);
      const account = this.attachStoredTreasuryMetadata(wallet, await this.getAccountSummary(wallet));
      this.recordTreasuryEvent(account, { type: "borrow", asset, amount });
      this.accounts.set(wallet, account);
      return account;
    }

    const account = await this.getAccountSummary(wallet);
    this.ensureTreasuryMetadata(account);
    account.liquid[asset] = (account.liquid[asset] ?? 0) + amount;
    account.debtOutstanding[asset] = (account.debtOutstanding[asset] ?? 0) + amount;
    this.recordTreasuryEvent(account, { type: "borrow", asset, amount });
    this.accounts.set(wallet, account);
    return account;
  }

  /**
   * Agent-to-agent on-platform transfer. Moves `amount` from `from`'s
   * liquid bucket to `recipient`'s liquid bucket without touching the
   * underlying ERC20. Mirrors the `AgentAccountCore.sendToAgentFor`
   * contract primitive when the blockchain gateway is enabled, and falls
   * back to an in-memory bookkeeping update on the local dev path.
   */
  async agentTransfer(from, recipient, asset, amount) {
    if (!from || !recipient) {
      throw new ValidationError("from and recipient are required");
    }
    if (from.toLowerCase() === recipient.toLowerCase()) {
      throw new ValidationError("from and recipient must differ");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }

    if (this.blockchainGateway?.isEnabled() && this.blockchainGateway.sendToAgent) {
      await this.blockchainGateway.sendToAgent(from, recipient, asset, amount);
      return {
        from: await this.getAccountSummary(from),
        to: await this.getAccountSummary(recipient)
      };
    }

    const fromAccount = await this.getAccountSummary(from);
    const toAccount = await this.getAccountSummary(recipient);
    const fromLiquid = fromAccount.liquid[asset] ?? 0;
    if (fromLiquid < amount) {
      throw new InsufficientLiquidityError(asset, {
        wallet: from,
        required: amount,
        available: fromLiquid
      });
    }
    fromAccount.liquid[asset] = fromLiquid - amount;
    toAccount.liquid[asset] = (toAccount.liquid[asset] ?? 0) + amount;
    this.accounts.set(from, fromAccount);
    this.accounts.set(recipient, toAccount);
    return { from: fromAccount, to: toAccount };
  }

  async repay(wallet, asset, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number");
    }
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.repay(asset, amount);
      const account = this.attachStoredTreasuryMetadata(wallet, await this.getAccountSummary(wallet));
      this.recordTreasuryEvent(account, { type: "repay", asset, amount });
      this.accounts.set(wallet, account);
      return account;
    }

    const account = await this.getAccountSummary(wallet);
    this.ensureTreasuryMetadata(account);
    const outstanding = account.debtOutstanding[asset] ?? 0;
    if (outstanding < amount) {
      throw new ConflictError(`Repay amount exceeds debt for ${asset}`, "repay_amount_exceeds_debt");
    }

    account.debtOutstanding[asset] = outstanding - amount;
    account.liquid[asset] = Math.max((account.liquid[asset] ?? 0) - amount, 0);
    this.recordTreasuryEvent(account, { type: "repay", asset, amount });
    this.accounts.set(wallet, account);
    return account;
  }
}
