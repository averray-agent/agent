import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { blake2AsHex } from "@polkadot/util-crypto";

import { findCommitOpeningCheckpoint, pendingV1RecallActions } from "./v1-lane-recall.mjs";
import {
  V1_RECALL,
  assertCallHashShape,
  assertPoolLaneUntouched,
  buildLegCTransferCall,
  buildReviveCallPayload,
  buildStageTreasuryWithdrawCall,
  deriveLegCTransfer,
  deriveTreasuryContext,
} from "./v1-lane-recall-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEPOSIT_REQUEST = "0xeaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767";

function depositEvidence() {
  return {
    kind: "averray.bankV22DepositDispatchBackfill",
    event: {
      data: {
        requestId: DEPOSIT_REQUEST,
        wrapper: V1_RECALL.wrapper.toLowerCase(),
        leg: "deposit_sell",
        legIndex: 1,
        remoteExecution: {
          event: { data: { fillerType: "AAVE", assetIn: 22, assetOut: 1003 } },
        },
      },
    },
  };
}

function adapterDeposit() {
  return {
    kind: 0,
    status: 2,
    account: V1_RECALL.owner,
    requester: V1_RECALL.owner,
    recipient: V1_RECALL.owner,
    requestedAssets: 10_050_000n,
    settledAssets: V1_RECALL.recordedBookRaw,
    settledShares: V1_RECALL.allSharesRaw,
    settled: true,
  };
}

function wrapperDeposit() {
  return {
    context: {
      strategyId: V1_RECALL.strategyId,
      kind: 0,
      account: V1_RECALL.owner,
      recipient: V1_RECALL.owner,
      assets: 10_050_000n,
    },
    queuedBy: V1_RECALL.adapter,
    status: 2,
    settledAssets: V1_RECALL.recordedBookRaw,
    settledShares: V1_RECALL.allSharesRaw,
  };
}

test("Leg A refuses without a context derived from deposit evidence", () => {
  assert.throws(
    () => buildStageTreasuryWithdrawCall({
      shares: V1_RECALL.allSharesRaw,
      dispatchDeadline: 1_800_000_000n,
      nonce: 3n,
    }),
    /without a treasuryContext derived/u,
  );
  assert.throws(
    () => deriveTreasuryContext({
      depositEvidence: null,
      adapterRequest: adapterDeposit(),
      wrapperRequest: wrapperDeposit(),
      currentTotalShares: V1_RECALL.allSharesRaw,
    }),
    /deposit evidence/u,
  );
});

test("deposit evidence and both live request records derive one treasury context", () => {
  const derived = deriveTreasuryContext({
    depositEvidence: depositEvidence(),
    adapterRequest: adapterDeposit(),
    wrapperRequest: wrapperDeposit(),
    currentTotalShares: V1_RECALL.allSharesRaw,
  });
  assert.equal(derived.requestId, DEPOSIT_REQUEST);
  assert.equal(derived.treasuryContext, V1_RECALL.owner);

  const wrong = adapterDeposit();
  wrong.requester = V1_RECALL.settler;
  assert.throws(
    () => deriveTreasuryContext({
      depositEvidence: depositEvidence(),
      adapterRequest: wrong,
      wrapperRequest: wrapperDeposit(),
      currentTotalShares: V1_RECALL.allSharesRaw,
    }),
    /unambiguous treasury context/u,
  );
});

test("Leg C refuses when the multisig balance is below expected proceeds", () => {
  const evidence = {
    kind: "averray.v1LaneRecallEvidence",
    phase: "completed",
    opening: { multisigUsdcRaw: "100" },
    settlement: { homeArrivalRaw: "999" },
  };
  assert.throws(
    () => deriveLegCTransfer({ evidence, currentMultisigBalance: 998n }),
    /below expected proceeds/u,
  );
  const exact = deriveLegCTransfer({ evidence, currentMultisigBalance: 1_099n });
  assert.equal(exact.arrivedRaw, 999n);
  assert.equal(buildLegCTransferCall({ amount: exact.arrivedRaw }).decoded.amount, 999n);
});

test("wrong-lane movement is incident-class and fails every phase", () => {
  const opening = {
    totalAssetsRaw: 4_950_004n,
    totalSharesRaw: 4_950_004n,
    pendingWithdrawalSharesRaw: 0n,
  };
  assert.doesNotThrow(() => assertPoolLaneUntouched(opening, { ...opening }, "preflight"));
  assert.throws(
    () => assertPoolLaneUntouched(opening, { ...opening, totalAssetsRaw: 4_950_003n }, "sell"),
    /INCIDENT: pool lane totalAssetsRaw moved/u,
  );
});

test("Nova payload is revive.call method SCALE with a 32-byte blake2 call hash", () => {
  const call = buildStageTreasuryWithdrawCall({
    treasuryContext: V1_RECALL.owner,
    dispatchDeadline: 1_800_000_000n,
    nonce: 3n,
  });
  const seen = {};
  const api = {
    tx: {
      revive: {
        call(to, value, weight, deposit, data) {
          Object.assign(seen, { to, value, weight, deposit, data });
          const bytes = Buffer.from(`0601${data.slice(2)}`, "hex");
          return { method: { toHex: () => `0x${bytes.toString("hex")}`, toU8a: () => bytes } };
        },
      },
    },
  };
  const payload = buildReviveCallPayload({ api, call, blake2AsHex });
  assert.equal(seen.weight.refTime, 4_000_000_000n);
  assert.equal(seen.weight.proofSize, 100_000n);
  assert.equal(seen.deposit, 1_000_000_000n);
  assertCallHashShape({ scale: payload.scale, callHash: payload.callHash });
});

test("funds-in-flight bitmap never schedules an already-dispatched leg", () => {
  assert.equal(pendingV1RecallActions(0n)[0], "dispatch_withdraw_sell");
  assert.deepEqual(pendingV1RecallActions(4n), ["observe_swap", "dispatch_withdraw_home", "observe_arrival", "settle"]);
  assert.deepEqual(pendingV1RecallActions(12n), ["observe_swap", "observe_arrival", "settle"]);
  assert.throws(() => pendingV1RecallActions(8n), /refusing to guess or retry/u);
});

test("a resumed leg uses the latest commit opening, never a prior dry-run snapshot", () => {
  const dryRun = { phase: "preflight", mode: "dry-run", opening: { aUsdcRaw: "1" } };
  const firstCommit = { phase: "preflight", mode: "commit", opening: { aUsdcRaw: "2" } };
  const latestCommit = { phase: "preflight", mode: "commit", opening: { aUsdcRaw: "3" } };
  assert.equal(findCommitOpeningCheckpoint([dryRun, firstCommit, latestCommit]), latestCommit);
  assert.equal(findCommitOpeningCheckpoint([dryRun]), null);
});

test("recall scripts expose no raw-key path", async () => {
  const sources = await Promise.all([
    readFile(resolve(here, "v1-lane-recall.mjs"), "utf8"),
    readFile(resolve(here, "build-v1-lane-recall-multisig.mjs"), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /PRIVATE_KEY|new Wallet|--private-key/u);
  }
  assert.match(sources[0], /Commit requires --use-kms/u);
});

test("--quote-account is parsed and forwarded only when supplied", async () => {
  const { parseArgs } = await import("./v1-lane-recall.mjs");
  const withFlag = parseArgs(["--profile","mainnet","--request-id","0x"+"11".repeat(32),"--expected-signer","0x5a6836c6D4d293F6E5377E6c28054F4171915813","--quote-account","12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4"]);
  assert.equal(withFlag.quoteAccount, "12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4");
  const without = parseArgs(["--profile","mainnet","--request-id","0x"+"11".repeat(32),"--expected-signer","0x5a6836c6D4d293F6E5377E6c28054F4171915813"]);
  assert.equal(without.quoteAccount, undefined);
});
