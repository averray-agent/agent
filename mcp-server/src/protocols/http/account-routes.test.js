import assert from "node:assert/strict";
import test from "node:test";

import { ValidationError } from "../../core/errors.js";
import { createAccountRoutes } from "./account-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
  claims: { roles: ["admin"] }
};

const DEFAULT_STRATEGIES = [
  {
    strategyId: "default-low-risk",
    asset: "0x0000000000000000000000000000000000000abc",
    assetConfig: { symbol: "USDC" },
    riskLabel: "low"
  }
];

function stripIdempotencyKey(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { idempotencyKey, ...rest } = payload;
  return rest;
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {};
  const strategies = overrides.strategies ?? DEFAULT_STRATEGIES;
  const account = overrides.account ?? {
    liquid: { DOT: 10 },
    debtOutstanding: { DOT: 0 },
    strategyAllocated: { DOT: 1 },
    strategyShares: {},
    strategyPending: {},
    strategyActivity: {},
    strategyAccounting: {}
  };
  const gateway = overrides.gateway ?? {
    isEnabled: () => false,
    config: {
      agentAccountAddress: "0x2222222222222222222222222222222222222222",
      supportedAssets: [{ address: "0x0000000000000000000000000000000000000abc", symbol: "USDC" }]
    },
    getStrategyPositions: async () => {
      calls.push(["getStrategyPositions"]);
      return [];
    },
    getStrategyTelemetry: async () => {
      calls.push(["getStrategyTelemetry"]);
      return [];
    }
  };
  const service = overrides.service ?? {
    getAccountSummary: async (wallet) => {
      calls.push(["getAccountSummary", wallet]);
      return account;
    },
    getAccountPosition: async (wallet, asset) => {
      calls.push(["getAccountPosition", { wallet, asset }]);
      return overrides.accountPosition ?? {
        wallet,
        asset: { symbol: asset },
        source: {
          contract: "AgentAccountCore",
          address: gateway.config.agentAccountAddress,
          method: "positions",
          field: "liquid"
        },
        position: { liquidRaw: "123000", liquid: 0.123 }
      };
    },
    getBorrowCapacity: async (wallet, asset) => {
      calls.push(["getBorrowCapacity", { wallet, asset }]);
      return overrides.borrowCapacity ?? 5;
    },
    fundAccount: async (wallet, asset, amount) => {
      calls.push(["fundAccount", { wallet, asset, amount }]);
      return { status: "funded", wallet, asset, amount };
    },
    allocateIdleFunds: async (wallet, asset, amount, strategyId, strategy, options) => {
      calls.push(["allocateIdleFunds", { wallet, asset, amount, strategyId, strategy, options }]);
      return { status: "allocated", wallet, asset, amount, strategyId, options };
    },
    deallocateIdleFunds: async (wallet, asset, amount, strategyId, strategy, options) => {
      calls.push(["deallocateIdleFunds", { wallet, asset, amount, strategyId, strategy, options }]);
      return { status: "deallocated", wallet, asset, amount, strategyId, options };
    },
    recordStrategySnapshots: async (wallet, snapshots) => {
      calls.push(["recordStrategySnapshots", { wallet, snapshots }]);
      return overrides.timeline ?? [{ id: "t1", amount: 2, at: "2026-01-01T00:00:00.000Z" }];
    },
    borrow: async (wallet, asset, amount) => {
      calls.push(["borrow", { wallet, asset, amount }]);
      return { status: "borrowed", wallet, asset, amount };
    },
    repay: async (wallet, asset, amount) => {
      calls.push(["repay", { wallet, asset, amount }]);
      return { status: "repaid", wallet, asset, amount };
    }
  };

  const route = createAccountRoutes({
    authMiddleware: async (_request, _url) => {
      calls.push(["auth"]);
      return overrides.auth ?? AUTH;
    },
    buildIdempotentMutationContext: (input) => {
      calls.push(["buildContext", input]);
      return overrides.context ?? { bucket: input.bucket, key: `key:${input.bucket}`, requestHash: `hash:${input.bucket}` };
    },
    buildMutationRequestHash: (input) => {
      calls.push(["buildMutationRequestHash", input]);
      return overrides.requestHash ?? `hash:${input.route}:${input.payload.strategyId}`;
    },
    ensureAsyncXcmTreasuryAdmin: (auth) => {
      calls.push(["ensureAsyncXcmTreasuryAdmin", auth.wallet]);
    },
    gateway,
    getIdempotentMutationReplay: async (context) => {
      calls.push(["getReplay", context]);
      return overrides.replay;
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    requireChainBackedMutation: async (routeName) => {
      calls.push(["requireChainBackedMutation", routeName]);
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    runIdempotentMutation: async (res, context, statusCode, operation) => {
      calls.push(["runIdempotentMutation", { context, statusCode }]);
      const body = await operation();
      res.statusCode = statusCode;
      res.body = body;
      calls.push(["respond", { statusCode, body, headers: {} }]);
    },
    service,
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
    strategies,
    stripIdempotencyKey,
  });

  return { calls, response, route };
}

test("account routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-account"),
    pathname: "/not-account",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /strategies returns public strategy metadata with cache headers", async () => {
  const { response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/strategies"),
    pathname: "/strategies",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.strategies, DEFAULT_STRATEGIES);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
});

test("GET /account returns stored summary when live strategies are disabled", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/account"),
    pathname: "/account",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.strategyAllocated, { DOT: 1 });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth"],
    ["getAccountSummary", AUTH.wallet],
    ["respond", { statusCode: 200, body: response.body, headers: {} }],
  ]);
});

test("GET /account overlays live strategy allocation by asset symbol", async () => {
  const gateway = {
    isEnabled: () => true,
    config: {
      supportedAssets: [{ address: "0x0000000000000000000000000000000000000abc", symbol: "USDC" }]
    },
    getStrategyPositions: async () => [{ strategyId: "default-low-risk", shares: 5 }],
    getStrategyTelemetry: async () => [{ strategyId: "default-low-risk", reported: true, sharePrice: 2 }]
  };
  const { response, route } = makeHarness({ gateway });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/account"),
    pathname: "/account",
  });

  assert.equal(handled, true);
  assert.deepEqual(response.body.strategyAllocated, { DOT: 1, USDC: 10 });
});

test("GET /account/position returns chain-backed wallet asset position", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/account/position?asset=usdc"),
    pathname: "/account/position",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, AUTH.wallet);
  assert.equal(response.body.asset.symbol, "USDC");
  assert.equal(response.body.source.method, "positions");
  assert.equal(response.body.position.liquidRaw, "123000");
  assert.deepEqual(calls.slice(0, 3), [
    ["auth"],
    ["getAccountPosition", { wallet: AUTH.wallet, asset: "USDC" }],
    ["respond", { statusCode: 200, body: response.body, headers: {} }],
  ]);
});

test("GET /account/borrow-capacity returns wallet-scoped capacity", async () => {
  const { response, route } = makeHarness({ borrowCapacity: 12 });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/account/borrow-capacity?asset=USDC"),
    pathname: "/account/borrow-capacity",
  });

  assert.equal(handled, true);
  assert.deepEqual(response.body, {
    wallet: AUTH.wallet,
    asset: "USDC",
    borrowCapacity: 12
  });
});

test("POST /account/fund keeps mutation idempotency and normalized payload", async () => {
  const { calls, response, route } = makeHarness({
    payload: { amount: 7, idempotencyKey: "idem-1" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/account/fund?asset=USDC"),
    pathname: "/account/fund",
  });

  const contextCall = calls.find(([name]) => name === "buildContext");
  assert.equal(handled, true);
  assert.deepEqual(contextCall[1].normalizedPayload, { amount: 7, asset: "USDC" });
  assert.deepEqual(calls.map(([name]) => name).filter((name) => name === "requireChainBackedMutation"), [
    "requireChainBackedMutation"
  ]);
  assert.deepEqual(response.body, { status: "funded", wallet: AUTH.wallet, asset: "USDC", amount: 7 });
});

test("POST /account/allocate sync path preserves strategy selection", async () => {
  const { calls, response, route } = makeHarness({
    payload: { amount: 3, strategyId: "default-low-risk" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/account/allocate"),
    pathname: "/account/allocate",
  });

  assert.equal(handled, true);
  const allocateCall = calls.find(([name]) => name === "allocateIdleFunds");
  assert.equal(allocateCall[1].asset, "DOT");
  assert.equal(allocateCall[1].amount, 3);
  assert.equal(allocateCall[1].strategyId, "default-low-risk");
  assert.equal(response.body.status, "allocated");
});

test("POST /account/allocate async path stores idempotent receipt", async () => {
  const strategies = [
    {
      strategyId: "async-lane",
      executionMode: "async_xcm",
      asset: "0x0000000000000000000000000000000000000abc",
      assetConfig: { symbol: "USDC" }
    }
  ];
  const { calls, response, route } = makeHarness({
    strategies,
    payload: {
      amount: 4,
      strategyId: "async-lane",
      idempotencyKey: "idem-async",
      maxWeight: { refTime: 11, proofSize: 22 },
      shares: "9"
    }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/account/allocate"),
    pathname: "/account/allocate",
  });

  const allocateCall = calls.find(([name]) => name === "allocateIdleFunds");
  const storeCall = calls.find(([name]) => name === "storeReceipt");
  assert.equal(handled, true);
  assert.equal(allocateCall[1].asset, "USDC");
  assert.equal(allocateCall[1].options.maxWeight.refTime, 11);
  assert.equal(allocateCall[1].options.requestedShares, 9);
  assert.equal(typeof allocateCall[1].options.nonce, "number");
  assert.equal(storeCall[1].bucket, "account_allocate_async");
  assert.equal(response.body.status, "allocated");
});

test("POST /account/deallocate async path rejects caller-assembled XCM fields", async () => {
  const strategies = [
    {
      strategyId: "async-lane",
      executionMode: "async_xcm",
      assetConfig: { symbol: "USDC" }
    }
  ];
  const { route } = makeHarness({
    strategies,
    payload: { amount: 1, strategyId: "async-lane", destination: { parents: 1 } }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/account/deallocate"),
      pathname: "/account/deallocate",
    }),
    ValidationError
  );
});

test("GET /account/strategies builds treasury positions and timeline", async () => {
  const { response, route } = makeHarness({
    account: {
      liquid: { DOT: 10 },
      debtOutstanding: { DOT: 2 },
      strategyAllocated: {},
      strategyShares: { "default-low-risk": 3 },
      strategyPending: {},
      strategyActivity: { "default-low-risk": { action: "allocated", at: "2026-01-01T00:00:00.000Z" } },
      strategyAccounting: { "default-low-risk": { principal: 2, realizedYield: 1 } }
    },
    borrowCapacity: 0
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/account/strategies"),
    pathname: "/account/strategies",
  });

  assert.equal(handled, true);
  assert.equal(response.body.summary.liquid, 10);
  assert.equal(response.body.summary.allocated, 3);
  assert.equal(response.body.summary.deployedLanes, 1);
  assert.equal(response.body.positions[0].attention.code, "credit_constrained");
  assert.equal(response.body.timeline[0].id, "t1");
  assert.equal(response.body.timeline[0].type, "treasury_event");
  assert.equal(response.body.timeline[0].asset, "DOT");
  assert.equal(response.body.timeline[0].amount, 2);
});

test("POST /account/repay uses the shared sync mutation path", async () => {
  const { response, route } = makeHarness({
    payload: { asset: "USDC", amount: 2 }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/account/repay"),
    pathname: "/account/repay",
  });

  assert.equal(handled, true);
  assert.deepEqual(response.body, { status: "repaid", wallet: AUTH.wallet, asset: "USDC", amount: 2 });
});
