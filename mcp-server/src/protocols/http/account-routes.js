import { keccak256, toUtf8Bytes } from "ethers";

import { ValidationError } from "../../core/errors.js";

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

function resolveAssetSymbol(gateway, assetAddress) {
  if (!assetAddress) return "DOT";
  const supportedAssets = gateway?.config?.supportedAssets ?? [];
  const match = supportedAssets.find((asset) => asset.address?.toLowerCase() === assetAddress.toLowerCase());
  return match?.symbol ?? "DOT";
}

function resolveStrategyAssetSymbol(gateway, strategy) {
  return strategy?.assetConfig?.symbol ?? resolveAssetSymbol(gateway, strategy?.asset);
}

function findStrategyConfig({ gateway, strategies, strategyId }) {
  if (!strategyId) return undefined;
  const normalized = gateway?.normalizeStrategyId?.(strategyId) ?? strategyId;
  return strategies.find((entry) => entry.strategyId === strategyId || entry.strategyId === normalized);
}

function normalizeAsyncWeight(input = undefined) {
  return {
    refTime: input?.refTime ?? input?.ref_time ?? 0,
    proofSize: input?.proofSize ?? input?.proof_size ?? 0
  };
}

function deriveAsyncNonce(seed) {
  const hash = keccak256(toUtf8Bytes(seed));
  return Number.parseInt(hash.slice(2, 14), 16);
}

function rejectCallerSuppliedAsyncXcmField(payload, url, field) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
    throw new ValidationError(`Async XCM ${field} is assembled by the server and cannot be supplied by the caller.`);
  }
  if (url.searchParams.has(field)) {
    throw new ValidationError(`Async XCM ${field} is assembled by the server and cannot be supplied by the caller.`);
  }
}

function parseAsyncTreasuryOptions(payload = {}, url, { defaultRecipient = undefined } = {}) {
  rejectCallerSuppliedAsyncXcmField(payload, url, "destination");
  rejectCallerSuppliedAsyncXcmField(payload, url, "message");
  rejectCallerSuppliedAsyncXcmField(payload, url, "nonce");

  const queryWeight = {
    refTime: url.searchParams.get("maxWeightRefTime"),
    proofSize: url.searchParams.get("maxWeightProofSize")
  };
  const maxWeight = normalizeAsyncWeight(
    payload?.maxWeight && typeof payload.maxWeight === "object"
      ? payload.maxWeight
      : queryWeight
  );
  const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
    ? payload.idempotencyKey.trim()
    : undefined;
  const recipient = typeof payload?.recipient === "string" && payload.recipient.trim()
    ? payload.recipient.trim()
    : (url.searchParams.get("recipient")?.trim() || defaultRecipient);
  const requestedSharesRaw = payload?.requestedShares ?? payload?.shares ?? url.searchParams.get("shares");
  const requestedShares = Number.isFinite(Number(requestedSharesRaw)) && Number(requestedSharesRaw) > 0
    ? Number(requestedSharesRaw)
    : undefined;
  return {
    maxWeight,
    idempotencyKey,
    recipient,
    requestedShares
  };
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

function readAsset(payload, url) {
  return typeof payload?.asset === "string" && payload.asset.trim()
    ? payload.asset.trim()
    : (url.searchParams.get("asset")?.trim() || "DOT");
}

function readAmount(payload, url) {
  return Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
}

function readStrategyId(payload, url) {
  return typeof payload?.strategyId === "string" && payload.strategyId.trim()
    ? payload.strategyId.trim()
    : (url.searchParams.get("strategyId")?.trim() || "default-low-risk");
}

export function createAccountRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  buildMutationRequestHash,
  ensureAsyncXcmTreasuryAdmin,
  gateway,
  getIdempotentMutationReplay,
  readJsonBody,
  requireChainBackedMutation,
  respond,
  runIdempotentMutation,
  service,
  storeIdempotentMutationReceipt,
  strategies,
  stripIdempotencyKey,
}) {
  async function handleSyncAccountMutation({ request, response, url, route, bucket, operation }) {
    const auth = await authMiddleware(request, url);
    const payload = await readJsonBody(request);
    const asset = readAsset(payload, url);
    const amount = readAmount(payload, url);
    const idempotency = buildIdempotentMutationContext({
      route,
      auth,
      payload,
      normalizedPayload: {
        ...stripIdempotencyKey(payload),
        asset,
        amount
      },
      bucket
    });
    await runIdempotentMutation(response, idempotency, 200, async () => {
      await requireChainBackedMutation(route);
      return operation({ wallet: auth.wallet, asset, amount });
    });
    return true;
  }

  return async function handleAccountRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/strategies") {
      respond(
        response,
        200,
        {
          strategies,
          docs: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md"
        },
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/account") {
      const auth = await authMiddleware(request, url);
      const account = await service.getAccountSummary(auth.wallet);
      if (!gateway?.isEnabled?.() || !strategies.length) {
        respond(response, 200, account);
        return true;
      }

      const [strategyPositions, strategyTelemetry] = await Promise.all([
        gateway.getStrategyPositions(auth.wallet, strategies).catch(() => []),
        gateway.getStrategyTelemetry(strategies).catch(() => [])
      ]);
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

      respond(response, 200, {
        ...account,
        strategyAllocated: {
          ...account.strategyAllocated,
          ...liveAllocatedByAsset
        }
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/account/borrow-capacity") {
      const auth = await authMiddleware(request, url);
      const asset = url.searchParams.get("asset")?.trim() || "DOT";
      respond(response, 200, {
        wallet: auth.wallet,
        asset,
        borrowCapacity: await service.getBorrowCapacity(auth.wallet, asset)
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/account/fund") {
      return handleSyncAccountMutation({
        request,
        response,
        url,
        route: "/account/fund",
        bucket: "account_fund",
        operation: ({ wallet, asset, amount }) => service.fundAccount(wallet, asset, amount)
      });
    }

    if (request.method === "POST" && pathname === "/account/allocate") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = readAsset(payload, url);
      const strategyId = readStrategyId(payload, url);
      const amount = readAmount(payload, url);
      const strategy = findStrategyConfig({ gateway, strategies, strategyId });
      if (strategy?.executionMode === "async_xcm") {
        await requireChainBackedMutation("/account/allocate");
        ensureAsyncXcmTreasuryAdmin(auth);
        const strategyAsset = resolveStrategyAssetSymbol(gateway, strategy);
        const options = parseAsyncTreasuryOptions(payload, url);
        const mutationKey = options.idempotencyKey
          ? `${auth.wallet}:${strategyId}:${options.idempotencyKey}`
          : undefined;
        const requestHash = buildMutationRequestHash({
          route: "/account/allocate",
          wallet: auth.wallet,
          payload: {
            ...payload,
            asset,
            amount,
            strategyId,
            strategyAsset,
            asyncXcm: stripIdempotencyKey(options)
          }
        });
        const replay = await getIdempotentMutationReplay({
          bucket: "account_allocate_async",
          key: mutationKey,
          requestHash
        });
        if (replay) {
          respond(response, replay.statusCode, replay.body);
          return true;
        }
        const nonce = options.nonce ?? (mutationKey ? deriveAsyncNonce(mutationKey) : Date.now());
        const result = await service.allocateIdleFunds(
          auth.wallet,
          strategyAsset,
          amount,
          strategyId,
          strategy,
          { ...options, nonce }
        );
        await storeIdempotentMutationReceipt({
          bucket: "account_allocate_async",
          key: mutationKey,
          requestHash,
          response: result,
          statusCode: 200
        });
        respond(response, 200, result);
        return true;
      }
      const idempotency = buildIdempotentMutationContext({
        route: "/account/allocate",
        auth,
        payload,
        normalizedPayload: {
          ...stripIdempotencyKey(payload),
          asset,
          amount,
          strategyId
        },
        bucket: "account_allocate_sync"
      });
      await runIdempotentMutation(response, idempotency, 200, async () => {
        await requireChainBackedMutation("/account/allocate");
        return service.allocateIdleFunds(auth.wallet, asset, amount, strategyId, strategy);
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/account/deallocate") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = readAsset(payload, url);
      const strategyId = readStrategyId(payload, url);
      const amount = readAmount(payload, url);
      const strategy = findStrategyConfig({ gateway, strategies, strategyId });
      if (strategy?.executionMode === "async_xcm") {
        await requireChainBackedMutation("/account/deallocate");
        ensureAsyncXcmTreasuryAdmin(auth);
        const strategyAsset = resolveStrategyAssetSymbol(gateway, strategy);
        const options = parseAsyncTreasuryOptions(payload, url, {
          defaultRecipient: gateway?.config?.agentAccountAddress
        });
        const mutationKey = options.idempotencyKey
          ? `${auth.wallet}:${strategyId}:${options.idempotencyKey}`
          : undefined;
        const requestHash = buildMutationRequestHash({
          route: "/account/deallocate",
          wallet: auth.wallet,
          payload: {
            ...payload,
            asset,
            amount,
            strategyId,
            strategyAsset,
            asyncXcm: stripIdempotencyKey(options)
          }
        });
        const replay = await getIdempotentMutationReplay({
          bucket: "account_deallocate_async",
          key: mutationKey,
          requestHash
        });
        if (replay) {
          respond(response, replay.statusCode, replay.body);
          return true;
        }
        const nonce = options.nonce ?? (mutationKey ? deriveAsyncNonce(mutationKey) : Date.now());
        const result = await service.deallocateIdleFunds(
          auth.wallet,
          strategyAsset,
          amount,
          strategyId,
          strategy,
          { ...options, nonce }
        );
        await storeIdempotentMutationReceipt({
          bucket: "account_deallocate_async",
          key: mutationKey,
          requestHash,
          response: result,
          statusCode: 200
        });
        respond(response, 200, result);
        return true;
      }
      const idempotency = buildIdempotentMutationContext({
        route: "/account/deallocate",
        auth,
        payload,
        normalizedPayload: {
          ...stripIdempotencyKey(payload),
          asset,
          amount,
          strategyId
        },
        bucket: "account_deallocate_sync"
      });
      await runIdempotentMutation(response, idempotency, 200, async () => {
        await requireChainBackedMutation("/account/deallocate");
        return service.deallocateIdleFunds(auth.wallet, asset, amount, strategyId, strategy);
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/account/strategies") {
      const auth = await authMiddleware(request, url);
      const account = await service.getAccountSummary(auth.wallet);
      const borrowCapacity = await service.getBorrowCapacity(auth.wallet, "DOT").catch(() => undefined);
      const adapterTelemetryByStrategy = gateway?.isEnabled?.()
        ? Object.fromEntries((await gateway.getStrategyTelemetry(strategies)).map((entry) => [entry.strategyId, entry]))
        : {};
      const strategyPositions = gateway?.isEnabled?.()
        ? await gateway.getStrategyPositions(auth.wallet, strategies)
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
        auth.wallet,
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
      respond(response, 200, {
        wallet: auth.wallet,
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
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/account/borrow") {
      return handleSyncAccountMutation({
        request,
        response,
        url,
        route: "/account/borrow",
        bucket: "account_borrow",
        operation: ({ wallet, asset, amount }) => service.borrow(wallet, asset, amount)
      });
    }

    if (request.method === "POST" && pathname === "/account/repay") {
      return handleSyncAccountMutation({
        request,
        response,
        url,
        route: "/account/repay",
        bucket: "account_repay",
        operation: ({ wallet, asset, amount }) => service.repay(wallet, asset, amount)
      });
    }

    return false;
  };
}
