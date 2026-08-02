import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BankXcmFlowCoordinator,
  XcmDryRunDispatchGuard
} from "./bank-xcm-flow.js";

const REQUEST_ID = `0x${"44".repeat(32)}`;
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/hydration-bank-round-trip.json", import.meta.url),
  "utf8"
));

test("dry-run invariant refuses signing when the expected Hydration event is absent", async () => {
  let signed = 0;
  const guard = new XcmDryRunDispatchGuard({
    dryRun: async () => ({ ok: true, executionSucceeded: true, events: [] })
  });
  await assert.rejects(
    guard.dispatch({
      requestId: REQUEST_ID,
      leg: "router_sell",
      payload: { message: "0x01" },
      expected: { event: { section: "broadcast", method: "Swapped", fields: { fillerType: "AAVE" } } }
    }, async () => { signed += 1; }),
    /did not emit expected broadcast\.Swapped/u
  );
  assert.equal(signed, 0);
});

test("dry-run invariant refuses signing when reserve transfer is not forwarded", async () => {
  let signed = 0;
  const guard = new XcmDryRunDispatchGuard({
    dryRun: async () => ({ ok: true, executionSucceeded: true, forwardedParaIds: [] })
  });
  await assert.rejects(
    guard.dispatch({
      requestId: REQUEST_ID,
      leg: "reserve_transfer",
      payload: { message: "0x02" },
      expected: { forwardedParaId: 2034 }
    }, async () => { signed += 1; }),
    /Sibling\(2034\)/u
  );
  assert.equal(signed, 0);
});

test("two-message bank flow queues then dispatches only after both exact dry-runs pass", async () => {
  const order = [];
  const guard = new XcmDryRunDispatchGuard({
    dryRun: async ({ leg }) => {
      order.push(`dry:${leg}`);
      return leg === "fund"
        ? { ok: true, executionSucceeded: true, forwardedParaIds: [2034], events: [] }
        : {
            ok: true,
            executionSucceeded: true,
            events: [{ section: "broadcast", method: "Swapped", data: { fillerType: "AAVE" } }]
          };
    }
  });
  const coordinator = new BankXcmFlowCoordinator({
    enabled: true,
    hasWrapper: () => true,
    balanceObserver: {
      async register(input) { order.push("watch"); return { ...input, baselineRaw: "0", deadlineAt: "later" }; }
    },
    dryRunGuard: guard
  });
  const result = await coordinator.execute({
    requestId: REQUEST_ID,
    intent: { kind: "deposit", assetsRaw: "100000" },
    observation: { target: { ledger: "erc20" }, direction: "increase" },
    messages: [
      { label: "fund", payload: { message: "0x01" }, expected: { forwardedParaId: 2034 } },
      {
        label: "sell",
        payload: { message: "0x02" },
        expected: { event: { section: "broadcast", method: "Swapped", fields: { fillerType: "AAVE" } } }
      }
    ],
    async queueRequest() { order.push("queue"); return { txHash: "0xqueue" }; },
    async waitForFollowUpReady() { order.push("ready"); },
    async dispatchFollowUp() { order.push("followup"); return { txHash: "0xfollowup" }; }
  });

  assert.deepEqual(order, ["watch", "dry:fund", "queue", "ready", "dry:sell", "followup"]);
  assert.equal(result.status, "pending_observation");
});

test("all four round-trip fixtures pass their exact dry-run evidence before dispatch", async () => {
  const signed = [];
  const guard = new XcmDryRunDispatchGuard({
    dryRun: async ({ leg }) => {
      const tx = fixture.transactions.find((entry) => entry.label === leg);
      const [section, method] = String(tx.dryRun.event).split(".");
      return {
        ok: true,
        executionSucceeded: true,
        forwardedParaIds: tx.dryRun.forwardedParaId === undefined ? [] : [tx.dryRun.forwardedParaId],
        events: [{
          section,
          method,
          data: {
            fillerType: tx.dryRun.fillerType,
            assetIn: tx.dryRun.assetIn,
            assetOut: tx.dryRun.assetOut
          }
        }]
      };
    }
  });

  for (const tx of fixture.transactions) {
    const [section, method] = String(tx.dryRun.event).split(".");
    const expected = {
      ...(tx.dryRun.forwardedParaId === undefined ? {} : { forwardedParaId: tx.dryRun.forwardedParaId }),
      event: {
        section,
        method,
        fields: Object.fromEntries(
          ["fillerType", "assetIn", "assetOut"]
            .filter((key) => tx.dryRun[key] !== undefined)
            .map((key) => [key, tx.dryRun[key]])
        )
      }
    };
    await guard.dispatch({
      requestId: REQUEST_ID,
      leg: tx.label,
      payload: { txHash: tx.txHash },
      expected
    }, async (payload) => {
      signed.push(payload.txHash);
      return { txHash: payload.txHash, blockNumber: tx.blockNumber };
    });
  }

  assert.deepEqual(signed, fixture.transactions.map((entry) => entry.txHash));
});

test("bank flow remains unavailable while xcmWrapper is null", async () => {
  const coordinator = new BankXcmFlowCoordinator({ enabled: true, hasWrapper: () => false });
  await assert.rejects(coordinator.execute({}), /XCM_WRAPPER_ADDRESS/u);
});
