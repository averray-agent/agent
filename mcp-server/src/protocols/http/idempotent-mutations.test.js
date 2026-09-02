import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError } from "../../core/errors.js";
import { createIdempotentMutationHelpers } from "./idempotent-mutations.js";

function makeHarness(overrides = {}) {
  const calls = [];
  const receipts = new Map(Object.entries(overrides.receipts ?? {}));
  const stateStore = {
    getMutationReceipt: async (bucket, key) => {
      calls.push(["getMutationReceipt", { bucket, key }]);
      return receipts.get(`${bucket}:${key}`);
    },
    upsertMutationReceipt: async (bucket, key, receipt) => {
      calls.push(["upsertMutationReceipt", { bucket, key, receipt }]);
      receipts.set(`${bucket}:${key}`, receipt);
    },
  };
  const helpers = createIdempotentMutationHelpers({
    stateStore,
    now: () => new Date("2026-06-06T10:00:00.000Z"),
    respond: (response, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      response.statusCode = statusCode;
      response.body = body;
    },
  });
  return { calls, helpers, receipts };
}

test("buildIdempotentMutationContext strips idempotencyKey from the request hash", () => {
  const { helpers } = makeHarness();
  const auth = { wallet: "0xabc" };
  const payload = { amount: 10, idempotencyKey: "same-key" };

  const withKey = helpers.buildIdempotentMutationContext({
    route: "/account/fund",
    auth,
    payload,
    bucket: "account_fund",
  });
  const withoutKey = helpers.buildMutationRequestHash({
    route: "/account/fund",
    wallet: auth.wallet,
    payload: { amount: 10 },
  });

  assert.equal(withKey.key, "0xabc:same-key");
  assert.equal(withKey.requestHash, withoutKey);
});

test("getIdempotentMutationReplay returns matching stored receipt envelopes", async () => {
  const { calls, helpers } = makeHarness({
    receipts: {
      "bucket:wallet:key": {
        requestHash: "hash-1",
        statusCode: 201,
        response: { ok: true },
      },
    },
  });

  const replay = await helpers.getIdempotentMutationReplay({
    bucket: "bucket",
    key: "wallet:key",
    requestHash: "hash-1",
  });

  assert.deepEqual(replay, { statusCode: 200, body: { ok: true } });
  assert.deepEqual(calls, [
    ["getMutationReceipt", { bucket: "bucket", key: "wallet:key" }],
  ]);
});

test("getIdempotentMutationReplay rejects payload drift", async () => {
  const { helpers } = makeHarness({
    receipts: {
      "bucket:wallet:key": {
        requestHash: "hash-original",
        statusCode: 200,
        response: { ok: true },
      },
    },
  });

  await assert.rejects(
    helpers.getIdempotentMutationReplay({
      bucket: "bucket",
      key: "wallet:key",
      requestHash: "hash-new",
    }),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "idempotency_key_payload_mismatch");
      assert.deepEqual(error.details, {
        bucket: "bucket",
        originalRequestHash: "hash-original",
        requestHash: "hash-new",
      });
      return true;
    }
  );
});

test("runIdempotentMutation stores a receipt and responds", async () => {
  const { calls, helpers } = makeHarness();
  const response = {};
  const context = {
    bucket: "bucket",
    key: "wallet:key",
    requestHash: "hash-1",
  };

  await helpers.runIdempotentMutation(response, context, 202, async () => ({ queued: true }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { queued: true });
  assert.deepEqual(calls, [
    ["getMutationReceipt", { bucket: "bucket", key: "wallet:key" }],
    ["upsertMutationReceipt", {
      bucket: "bucket",
      key: "wallet:key",
      receipt: {
        requestHash: "hash-1",
        statusCode: 202,
        response: { queued: true },
        createdAt: "2026-06-06T10:00:00.000Z",
      },
    }],
    ["respond", { statusCode: 202, body: { queued: true } }],
  ]);
});

test("runIdempotentMutation rejects duplicate in-flight keys before rerunning side effects", async () => {
  const { helpers } = makeHarness();
  const context = {
    bucket: "bucket",
    key: "wallet:key",
    requestHash: "hash-1",
  };
  let operationCount = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });

  const first = helpers.runIdempotentMutation({}, context, 200, async () => {
    operationCount += 1;
    await blocker;
    return { ok: true };
  });

  await assert.rejects(
    helpers.runIdempotentMutation({}, context, 200, async () => {
      operationCount += 1;
      return { duplicate: true };
    }),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "idempotency_key_in_flight");
      return true;
    }
  );

  release();
  await first;
  assert.equal(operationCount, 1);
});
