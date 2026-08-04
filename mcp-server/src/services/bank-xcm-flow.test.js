import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BankXcmV22Dispatcher,
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
      async requireArmedWatch(requestId) {
        assert.equal(requestId, REQUEST_ID);
        order.push("watch");
        return { requestId, target: { ledger: "erc20" }, baselineRaw: "0", deadlineAt: "later" };
      },
      async setRequestPhase(_requestId, phase) { order.push(`phase:${phase}`); }
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

  assert.deepEqual(order, [
    "watch",
    "dry:fund",
    "queue",
    "phase:leg1-dispatched",
    "ready",
    "dry:sell",
    "followup",
    "phase:leg2-dispatched"
  ]);
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

const WRAPPER = "0x1111111111111111111111111111111111111111";

function liveRequest(overrides = {}) {
  return {
    wrapper: WRAPPER,
    liveState: true,
    requestId: REQUEST_ID,
    kind: "deposit",
    status: "pending",
    dispatchPaused: false,
    operatorMatches: true,
    bitmap: 1,
    assets: "150000",
    parameters: {
      sellAmount: "100000",
      minimumOutput: "95000",
      maxFeePerLeg: "40000",
      dispatchDeadline: "0"
    },
    ...overrides
  };
}

function dispatcher(overrides = {}) {
  const calls = [];
  const instance = new BankXcmV22Dispatcher({
    enabled: true,
    expectedWrapper: WRAPPER,
    readLiveRequest: async () => liveRequest(),
    quoteRemoteFee: async () => ({ liveState: true, amount: "17000", asOf: 1_775_000_000 }),
    readRemoteOperatingFloat: async () => ({
      liveState: true,
      assets: "100000",
      asOf: 1_775_000_000,
      remoteRef: `0x${"77".repeat(32)}`
    }),
    readFundingTransferFee: async () => ({ liveState: true, amount: "525", asOf: 1_775_000_000 }),
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0x1234",
      events: [{
        section: "broadcast",
        method: "Swapped",
        data: { fillerType: "AAVE", assetIn: 22, assetOut: 1003 }
      }]
    }),
    simulateReviveCall: async () => ({
      liveState: true,
      success: true,
      weightUsed: { refTime: "1000", proofSize: "200" },
      storageDepositUsed: "50"
    }),
    estimateGas: async () => "18000",
    requireArmedWatch: async () => ({
      requestId: REQUEST_ID,
      target: { ledger: "erc20" },
      registrationSource: "chain_event",
      baselineRaw: "0",
      deadlineAt: "later"
    }),
    recordRemoteOperatingFloat: async (input) => {
      calls.push({ type: "float", input });
      return { status: 1, txHash: "0xfloat" };
    },
    signAndDispatch: async (input) => {
      calls.push({ type: "sign", input });
      return { status: 1, txHash: "0xdispatch", blockNumber: 123, gasUsed: "17800" };
    },
    ...overrides
  });
  return { instance, calls };
}

test("v2.2 dispatcher derives every limit live and refuses fork-derived evidence", async () => {
  let signed = 0;
  const { instance } = dispatcher({
    dryRunMessage: async () => ({
      liveState: false,
      ok: true,
      executionSucceeded: true,
      calldata: "0x1234"
    }),
    signAndDispatch: async () => { signed += 1; }
  });
  await assert.rejects(
    instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell" }),
    /liveState:true/u
  );
  assert.equal(signed, 0);
});

test("v2.2 dispatcher refuses a request snapshot or fee quote not marked live", async () => {
  const staleRequest = dispatcher({
    readLiveRequest: async () => liveRequest({ liveState: false })
  });
  await assert.rejects(
    staleRequest.instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell" }),
    /Request\/config capture is not marked liveState:true/u
  );

  const staleQuote = dispatcher({
    quoteRemoteFee: async () => ({ liveState: false, amount: "17000", asOf: 1_775_000_000 })
  });
  await assert.rejects(
    staleQuote.instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell" }),
    /remoteFeeQuote evidence is not marked liveState:true/u
  );
});

test("v2.2 dispatcher owns the leg expectation and caller input cannot weaken it", async () => {
  let signed = 0;
  const { instance } = dispatcher({
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0x1234",
      events: []
    }),
    signAndDispatch: async () => { signed += 1; }
  });
  await assert.rejects(
    instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell", expected: {} }),
    /Broadcast\.Swapped/u
  );
  assert.equal(signed, 0);
});

test("v2.2 deposit staging margin includes the fresh funding-transfer fee headroom", async () => {
  const { instance } = dispatcher({
    readLiveRequest: async () => liveRequest({ assets: "140524" })
  });
  await assert.rejects(
    instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell" }),
    /sellAmount \+ maxFeePerLeg \+ funding transfer fee headroom \(525\)/u
  );
});

test("v2.2 deposit sell quotes fresh x2, requires the event watch, and records actual gas", async () => {
  const { instance, calls } = dispatcher();
  const { evidence } = await instance.dispatch({
    requestId: REQUEST_ID,
    leg: "deposit_sell",
    gasLimit: 1,
    weightLimit: { refTime: 1, proofSize: 1 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.feeAmount, 34_000n);
  assert.deepEqual(calls[0].input.weightLimit, { refTime: 2_000n, proofSize: 400n });
  assert.equal(calls[0].input.storageDepositLimit, 100n);
  assert.equal(calls[0].input.gasLimit, 36_000n);
  assert.equal(evidence.evm.gasUsed, "17800");
  assert.equal(evidence.fundingTransferFeeHeadroomRaw, "525");
});

test("v2.2 withdraw sell uses fresh remote float and records it before signing", async () => {
  const { instance, calls } = dispatcher({
    readLiveRequest: async () => liveRequest({
      kind: "withdraw",
      bitmap: 0,
      assets: "0",
      parameters: {
        sellAmount: "100000",
        minimumOutput: "95000",
        maxFeePerLeg: "120000",
        dispatchDeadline: "0"
      }
    }),
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0x1234",
      events: [{
        section: "broadcast",
        method: "Swapped",
        data: { fillerType: "AAVE", assetIn: 1003, assetOut: 22 }
      }]
    })
  });
  const { evidence } = await instance.dispatch({ requestId: REQUEST_ID, leg: "withdraw_sell" });
  assert.deepEqual(calls.map((entry) => entry.type), ["float", "sign"]);
  assert.equal(calls[0].input.assets, 100_000n);
  assert.equal(calls[1].input.feeAmount, 100_000n);
  assert.equal(evidence.feeSource, "fresh_remote_operating_float");
});

test("v2.2 funding and home legs enforce their chain destinations with zero dispatch fee", async () => {
  const funding = dispatcher({
    readLiveRequest: async () => liveRequest({ bitmap: 0 }),
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0xfunding",
      forwardedParaIds: [2034],
      events: [{ section: "Tokens", method: "Deposited", data: {} }]
    })
  });
  await funding.instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_funding" });
  assert.equal(funding.calls[0].input.feeAmount, 0n);

  const home = dispatcher({
    readLiveRequest: async () => liveRequest({
      kind: "withdraw",
      bitmap: 4,
      assets: "0",
      parameters: {
        sellAmount: "100000",
        minimumOutput: "95000",
        maxFeePerLeg: "120000",
        dispatchDeadline: "0"
      }
    }),
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0xhome",
      forwardedParaIds: [1000],
      events: [{ section: "Assets", method: "Deposited", data: {} }]
    })
  });
  await home.instance.dispatch({ requestId: REQUEST_ID, leg: "withdraw_home" });
  assert.equal(home.calls[0].input.feeAmount, 0n);
});

test("v2.2 dispatcher refuses when a chain-event watch is absent", async () => {
  let signed = 0;
  const { instance } = dispatcher({
    requireArmedWatch: async () => { throw new Error("No pending chain-event observer watch exists"); },
    signAndDispatch: async () => { signed += 1; }
  });
  await assert.rejects(
    instance.dispatch({ requestId: REQUEST_ID, leg: "deposit_sell" }),
    /No pending chain-event/u
  );
  assert.equal(signed, 0);
});
