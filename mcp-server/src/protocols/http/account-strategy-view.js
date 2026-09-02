function sumNumericValues(record = {}) {
  return Object.values(record).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function ratioToBps(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10_000);
}

function normalizeRawIntegerString(value) {
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
  if (!/^\d+$/u.test(normalized)) {
    return undefined;
  }
  return BigInt(normalized).toString();
}

function calculateRoutedAmountRaw(sharesRaw, telemetry = {}) {
  const normalizedSharesRaw = normalizeRawIntegerString(sharesRaw);
  const totalAssetsRaw = normalizeRawIntegerString(telemetry.totalAssetsRaw);
  const totalSharesRaw = normalizeRawIntegerString(telemetry.totalSharesRaw);
  if (normalizedSharesRaw === undefined || totalAssetsRaw === undefined || totalSharesRaw === undefined) {
    return undefined;
  }
  const denominator = BigInt(totalSharesRaw);
  if (denominator <= 0n) {
    return undefined;
  }
  return ((BigInt(normalizedSharesRaw) * BigInt(totalAssetsRaw)) / denominator).toString();
}

export function resolveAssetSymbol(gateway, assetAddress) {
  if (!assetAddress) return "DOT";
  const supportedAssets = gateway?.config?.supportedAssets ?? [];
  const match = supportedAssets.find((asset) => asset.address?.toLowerCase() === assetAddress.toLowerCase());
  return match?.symbol ?? "DOT";
}

export function resolveStrategyAssetSymbol(gateway, strategy) {
  return strategy?.assetConfig?.symbol ?? resolveAssetSymbol(gateway, strategy?.asset);
}

function buildLaneAttention({ shares, isMock, debtTotal, borrowCapacity, deploymentShareBps }) {
  if (!(shares > 0)) {
    return undefined;
  }
  if (isMock) {
    return {
      code: "simulated_yield",
      tone: "tier-warn",
      message: "This lane is using the mock vDOT adapter, so yield is simulated rather than market-backed."
    };
  }
  if (debtTotal > 0 && !(borrowCapacity > 0)) {
    return {
      code: "credit_constrained",
      tone: "tier-warn",
      message: "This wallet has debt outstanding and no additional live borrow headroom."
    };
  }
  if (deploymentShareBps >= 7000) {
    return {
      code: "lane_concentration",
      tone: "status-pending",
      message: "Most deployed capital is concentrated in this lane right now."
    };
  }
  return undefined;
}

function formatAdapterYieldLabel({ telemetry, isMock, shares }) {
  if (!telemetry?.reported) {
    return isMock
      ? "Mock adapter is registered, but no simulated yield data is reported yet."
      : "Adapter is registered, but it is not reporting a live yield/performance read yet.";
  }
  const sharePrice = Number(telemetry.sharePrice);
  const performanceBps = Number(telemetry.performanceBps);
  const sharePriceLabel = Number.isFinite(sharePrice) ? `${sharePrice.toFixed(4)}x share price` : "share price unavailable";
  const driftLabel = Number.isFinite(performanceBps)
    ? `${performanceBps >= 0 ? "+" : ""}${performanceBps} bps`
    : "drift unavailable";
  if (shares > 0) {
    return `${sharePriceLabel} \u00b7 ${driftLabel} on the adapter for currently routed wallet capital.`;
  }
  return `${sharePriceLabel} \u00b7 ${driftLabel} on deployed adapter capital.`;
}

function normalizeTimelineEntry(entry = {}) {
  const amount = Number(entry.amount ?? 0);
  const yieldDelta = Number(entry.yieldDelta ?? entry.realizedYieldDelta ?? 0);
  return {
    id: entry.id,
    type: entry.type ?? "treasury_event",
    strategyId: entry.strategyId,
    asset: entry.asset ?? "DOT",
    amount,
    ...(entry.amountRaw !== undefined ? { amountRaw: normalizeRawIntegerString(entry.amountRaw) ?? String(entry.amountRaw) } : {}),
    yieldDelta,
    ...(entry.yieldDeltaRaw !== undefined ? { yieldDeltaRaw: String(entry.yieldDeltaRaw) } : {}),
    ...(entry.realizedYieldDeltaRaw !== undefined ? { realizedYieldDeltaRaw: String(entry.realizedYieldDeltaRaw) } : {}),
    ...(entry.principalAfterRaw !== undefined ? { principalAfterRaw: String(entry.principalAfterRaw) } : {}),
    ...(entry.markValueAfterRaw !== undefined ? { markValueAfterRaw: String(entry.markValueAfterRaw) } : {}),
    ...(entry.requestedSharesRaw !== undefined ? { requestedSharesRaw: String(entry.requestedSharesRaw) } : {}),
    at: entry.at
  };
}

export function buildLiveStrategyAllocationByAsset({
  gateway,
  strategies,
  strategyPositions = [],
  strategyTelemetry = []
}) {
  const sharesByStrategy = Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, Number(entry.shares ?? 0)]));
  const telemetryByStrategy = Object.fromEntries(strategyTelemetry.map((entry) => [entry.strategyId, entry]));
  const liveAllocatedByAsset = {};
  for (const strategy of strategies) {
    const shares = Number(sharesByStrategy[strategy.strategyId] ?? 0);
    if (!(shares > 0)) continue;
    const telemetry = telemetryByStrategy[strategy.strategyId];
    const liveValue = telemetry?.reported && Number.isFinite(Number(telemetry.sharePrice))
      ? shares * Number(telemetry.sharePrice)
      : shares;
    const symbol = resolveAssetSymbol(gateway, strategy.asset);
    liveAllocatedByAsset[symbol] = (liveAllocatedByAsset[symbol] ?? 0) + liveValue;
  }
  return liveAllocatedByAsset;
}

export async function buildAccountStrategiesView({
  wallet,
  account,
  borrowCapacity,
  gateway,
  service,
  strategies
}) {
  const adapterTelemetryByStrategy = gateway?.isEnabled?.()
    ? Object.fromEntries((await gateway.getStrategyTelemetry(strategies)).map((entry) => [entry.strategyId, entry]))
    : {};
  const strategyPositions = gateway?.isEnabled?.()
    ? await gateway.getStrategyPositions(wallet, strategies)
    : [];
  const sharesByStrategy = gateway?.isEnabled?.()
    ? Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, entry.shares]))
    : (account.strategyShares ?? {});
  const pendingByStrategy = gateway?.isEnabled?.()
    ? Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, entry]))
    : (account.strategyPending ?? {});
  const totalLiquid = sumNumericValues(account.liquid);
  const debtTotal = sumNumericValues(account.debtOutstanding);
  const strategyActivity = account.strategyActivity ?? {};
  const strategyAccounting = account.strategyAccounting ?? {};
  const positions = strategies.map((strategy) => {
    const shares = Number(sharesByStrategy[strategy.strategyId] ?? 0);
    const pendingPosition = pendingByStrategy[strategy.strategyId] ?? {};
    const sharesRaw = normalizeRawIntegerString(pendingPosition.sharesRaw);
    const pendingDepositAssets = Number(pendingPosition.pendingDepositAssets ?? 0);
    const pendingDepositAssetsRaw = normalizeRawIntegerString(pendingPosition.pendingDepositAssetsRaw);
    const pendingWithdrawalShares = Number(pendingPosition.pendingWithdrawalShares ?? 0);
    const pendingWithdrawalSharesRaw = normalizeRawIntegerString(pendingPosition.pendingWithdrawalSharesRaw);
    const lastMovement = strategyActivity[strategy.strategyId];
    const accounting = strategyAccounting[strategy.strategyId] ?? {};
    const isMock = String(strategy.kind ?? "").includes("mock");
    const telemetry = adapterTelemetryByStrategy[strategy.strategyId];
    const routedAmount = telemetry?.reported && Number.isFinite(Number(telemetry.sharePrice))
      ? shares * Number(telemetry.sharePrice)
      : shares;
    const routedAmountRaw = calculateRoutedAmountRaw(sharesRaw, telemetry);
    const principalValue = Number(accounting.principal ?? shares);
    const realizedYield = Number(accounting.realizedYield ?? 0);
    const unrealizedYield = routedAmount - principalValue;
    return {
      strategyId: strategy.strategyId,
      asset: strategy.asset,
      assetConfig: strategy.assetConfig,
      assetSymbol: resolveStrategyAssetSymbol(gateway, strategy),
      executionMode: strategy.executionMode ?? "sync",
      shares,
      ...(sharesRaw !== undefined ? { sharesRaw } : {}),
      shareCount: shares,
      pendingDepositAssets,
      ...(pendingDepositAssetsRaw !== undefined ? { pendingDepositAssetsRaw } : {}),
      pendingWithdrawalShares,
      ...(pendingWithdrawalSharesRaw !== undefined ? { pendingWithdrawalSharesRaw } : {}),
      routedAmount,
      ...(routedAmountRaw !== undefined ? { routedAmountRaw } : {}),
      principalValue,
      ...(accounting.principalRaw !== undefined ? { principalValueRaw: String(accounting.principalRaw) } : {}),
      ...(accounting.markValueRaw !== undefined ? { markValueRaw: String(accounting.markValueRaw) } : {}),
      unrealizedYield,
      realizedYield,
      ...(accounting.realizedYieldRaw !== undefined ? { realizedYieldRaw: String(accounting.realizedYieldRaw) } : {}),
      totalYield: realizedYield + unrealizedYield,
      statusLabel: pendingDepositAssets > 0
        ? "Pending deposit"
        : pendingWithdrawalShares > 0
          ? "Pending withdraw"
          : shares > 0
            ? "Routed"
            : "Idle",
      yieldReported: Boolean(telemetry?.reported),
      yieldStatus: telemetry?.reported ? (isMock ? "simulated" : "live") : (isMock ? "simulated_unreported" : "unreported"),
      yieldLabel: formatAdapterYieldLabel({ telemetry, isMock, shares }),
      sharePrice: telemetry?.sharePrice,
      performanceBps: telemetry?.performanceBps,
      adapterTotalAssets: telemetry?.totalAssets,
      ...(telemetry?.totalAssetsRaw !== undefined ? { adapterTotalAssetsRaw: String(telemetry.totalAssetsRaw) } : {}),
      adapterTotalShares: telemetry?.totalShares,
      ...(telemetry?.totalSharesRaw !== undefined ? { adapterTotalSharesRaw: String(telemetry.totalSharesRaw) } : {}),
      adapterLinked: true,
      adapterLinkStatus: shares > 0
        ? "Wallet capital is now settled into the adapter and priced from live adapter reads."
        : "Adapter performance is live even when this wallet has no routed capital in the lane.",
      riskLabel: telemetry?.riskLabel || strategy.riskLabel || "",
      lastAction: lastMovement?.action,
      lastMovementAt: lastMovement?.at,
      attention: buildLaneAttention({
        shares,
        isMock,
        debtTotal,
        borrowCapacity: Number(borrowCapacity),
        deploymentShareBps: 0
      })
    };
  });
  const totalAllocated = positions.reduce((sum, entry) => sum + (Number(entry.routedAmount) || 0), 0);
  const totalPrincipal = positions.reduce((sum, entry) => sum + (Number(entry.principalValue) || 0), 0);
  const totalUnrealizedYield = positions.reduce((sum, entry) => sum + (Number(entry.unrealizedYield) || 0), 0);
  const totalRealizedYield = positions.reduce((sum, entry) => sum + (Number(entry.realizedYield) || 0), 0);
  const treasuryBase = totalLiquid + totalAllocated;
  const normalizedPositions = positions.map((entry) => ({
    ...entry,
    deploymentShareBps: ratioToBps(Number(entry.routedAmount), totalAllocated),
    treasuryShareBps: ratioToBps(Number(entry.routedAmount), treasuryBase),
    attention: buildLaneAttention({
      shares: Number(entry.routedAmount),
      isMock: entry.yieldStatus === "simulated" || entry.yieldStatus === "simulated_unreported",
      debtTotal,
      borrowCapacity: Number(borrowCapacity),
      deploymentShareBps: ratioToBps(Number(entry.routedAmount), totalAllocated)
    })
  }));
  const treasuryTimeline = await service.recordStrategySnapshots(
    wallet,
    normalizedPositions.map((entry) => ({
      strategyId: entry.strategyId,
      asset: entry.asset,
      assetSymbol: entry.assetSymbol,
      shares: entry.shares,
      currentValue: entry.routedAmount,
      currentValueRaw: entry.routedAmountRaw,
      sharePrice: entry.sharePrice
    }))
  );
  return {
    wallet,
    summary: {
      treasuryBase,
      liquid: totalLiquid,
      allocated: totalAllocated,
      principal: totalPrincipal,
      unrealizedYield: totalUnrealizedYield,
      realizedYield: totalRealizedYield,
      totalYield: totalRealizedYield + totalUnrealizedYield,
      debt: debtTotal,
      borrowCapacity: Number.isFinite(Number(borrowCapacity)) ? Number(borrowCapacity) : undefined,
      deployedLanes: normalizedPositions.filter((entry) => entry.routedAmount > 0).length,
      attentionCount: normalizedPositions.filter((entry) => entry.attention).length
    },
    positions: normalizedPositions,
    timeline: (treasuryTimeline ?? []).map(normalizeTimelineEntry)
  };
}
