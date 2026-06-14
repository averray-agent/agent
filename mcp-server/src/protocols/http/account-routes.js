import { keccak256, toUtf8Bytes } from "ethers";

import { ValidationError } from "../../core/errors.js";
import {
  buildAccountStrategiesView,
  buildLiveStrategyAllocationByAsset,
  resolveStrategyAssetSymbol
} from "./account-strategy-view.js";

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
      if (!gateway?.isEnabled?.()) {
        respond(response, 200, account);
        return true;
      }

      // Surface the worker's EOA wallet balance alongside the AAC position. A
      // settled job reward lands in the worker's EOA, not their AAC `liquid`
      // position — so without this an agent that just got paid sees 0 earned.
      // Kept as a SEPARATE field, never folded into `liquid`: EOA funds are
      // paid-out, not yet stakeable in-platform until the worker deposits them.
      let withWallet = account;
      if (typeof gateway.getWalletTokenBalances === "function") {
        const wallet = await gateway.getWalletTokenBalances(auth.wallet).catch(() => null);
        if (wallet) {
          withWallet = {
            ...account,
            walletBalance: wallet.walletBalance,
            raw: { ...account.raw, walletBalance: wallet.raw }
          };
        }
      }

      if (!strategies.length) {
        respond(response, 200, withWallet);
        return true;
      }

      const [strategyPositions, strategyTelemetry] = await Promise.all([
        gateway.getStrategyPositions(auth.wallet, strategies).catch(() => []),
        gateway.getStrategyTelemetry(strategies).catch(() => [])
      ]);
      const liveAllocatedByAsset = buildLiveStrategyAllocationByAsset({
        gateway,
        strategies,
        strategyPositions,
        strategyTelemetry
      });

      respond(response, 200, {
        ...withWallet,
        strategyAllocated: {
          ...withWallet.strategyAllocated,
          ...liveAllocatedByAsset
        }
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/account/position") {
      const auth = await authMiddleware(request, url);
      const asset = url.searchParams.get("asset")?.trim().toUpperCase();
      if (!asset) {
        throw new ValidationError("asset query parameter is required.");
      }
      respond(response, 200, await service.getAccountPosition(auth.wallet, asset));
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
      respond(response, 200, await buildAccountStrategiesView({
        wallet: auth.wallet,
        account,
        borrowCapacity,
        gateway,
        service,
        strategies
      }));
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
