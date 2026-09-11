import assert from "node:assert/strict";
import test from "node:test";
import { buildYieldAttribution } from "./yield-attribution-service.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const subsidy = {
  txHash: `0x${"ab".repeat(32)}`, amountRaw: "600000", blockNumber: 30,
  chainId: 420420419, timestamp: "2026-09-09T00:00:00.000Z"
};
const event = (type, blockNumber, fields = {}) => ({ type, blockNumber, logIndex: 0, ...fields });
const deposit = (owner, raw, blockNumber = 1) => event("Deposit", blockNumber, {
  owner, assetsRaw: String(raw), sharesRaw: String(raw)
});
const returned = (returnedAssetsRaw, principalReductionRaw, blockNumber = 20) => event("VenuePrincipalReturned", blockNumber, {
  deploymentId: "1", returnedAssetsRaw: String(returnedAssetsRaw), principalReductionRaw: String(principalReductionRaw)
});
const writeOff = (assetsRaw, blockNumber = 25) => event("VenueLossWrittenOff", blockNumber, { deploymentId: "1", assetsRaw: String(assetsRaw) });
const snapshot = (bufferAssets, overrides = {}) => ({
  blockNumber: 40, totalSupply: 20_000_000n, totalAssets: bufferAssets,
  bufferAssets, deployedPrincipal: 0n, venueMarkedAssets: null, ...overrides
});
const cycleOne = [deposit(WALLET, 20_000_000), returned(9_928_372, 9_928_372), writeOff(51_765)];

function assertCloses(result) {
  const { gain, splitRatio } = result;
  assert.equal(BigInt(gain.venueEarned.raw) + BigInt(gain.operatorAdded.raw) + BigInt(gain.unattributed.raw), BigInt(gain.cumulativeNav.raw));
  if (splitRatio.status === "available") {
    assert.equal(BigInt(splitRatio.venueEarnedBps) + BigInt(splitRatio.operatorAddedBps) + BigInt(splitRatio.unattributedBps), 10_000n);
  }
}

test("realised venue pin 1 — cycle 1 cost is venue-earned -51765 and unattributed zero after attestation", () => {
  const result = buildYieldAttribution({ snapshot: snapshot(20_548_235n), events: cycleOne, ledgerEntries: [subsidy] });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.cumulativeNav.raw, "548235");
  assert.equal(result.gain.venueEarned.raw, "-51765");
  assert.equal(result.gain.operatorAdded.raw, "600000");
  assert.equal(result.gain.unattributed.raw, "0");
  assert.equal(result.basis.netShareBackedCapital.raw, "20000000");
  assertCloses(result);
  const beforeAttestation = buildYieldAttribution({ snapshot: snapshot(20_548_235n), events: cycleOne });
  assert.equal(beforeAttestation.gain.venueEarned.raw, "-51765");
  assert.equal(beforeAttestation.gain.unattributed.raw, "600000", "only the unattested contribution remains unexplained");
});

test("realised venue pin 2 — profitable completed cycle attributes excess cash, not returned principal", () => {
  const result = buildYieldAttribution({
    snapshot: snapshot(20_250_000n),
    events: [deposit(WALLET, 20_000_000), returned(10_230_000, 10_000_000), returned(20_000, 0, 21)]
  });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.venueEarned.raw, "250000");
  assert.equal(result.gain.operatorAdded.raw, "0");
  assert.equal(result.gain.unattributed.raw, "0");
  assert.equal(result.splitRatio.venueEarnedBps, "10000");
  assert.equal(result.basis.netShareBackedCapital.raw, "20000000");
  assertCloses(result);
});

test("realised venue pin 3 — wallet split uses the pool ratio including realised loss and profit", () => {
  for (const [buffer, venueEvents, entries] of [
    [20_548_235n, cycleOne.slice(1), [subsidy]],
    [20_250_000n, [returned(10_250_000, 10_000_000)], []]
  ]) {
    const result = buildYieldAttribution({
      snapshot: snapshot(buffer, { wallet: { shares: 10_000_000n } }),
      events: [deposit(WALLET, 10_000_000), deposit(OTHER, 10_000_000), ...venueEvents],
      ledgerEntries: entries, wallet: WALLET
    });
    const split = result.wallet.splitApproximation;
    const gain = BigInt(result.wallet.gain.raw);
    assert.equal(split.status, "approximation");
    assert.deepEqual(split.poolRatio, result.splitRatio);
    assert.equal(BigInt(split.venueEarned.raw), gain * BigInt(result.gain.venueEarned.raw) / BigInt(result.gain.cumulativeNav.raw));
    assert.equal(BigInt(split.operatorAdded.raw), gain * BigInt(result.gain.operatorAdded.raw) / BigInt(result.gain.cumulativeNav.raw));
    assert.equal(BigInt(split.venueEarned.raw) + BigInt(split.operatorAdded.raw) + BigInt(split.unattributed.raw), gain);
    assert.equal(split.unattributed.raw, "0");
    assert.match(split.statement, /approximation, not a holding-period attribution/u);
    assertCloses(result);
  }
});

test("realised history adds to the outstanding mark and remains bounded by the snapshot block", () => {
  const result = buildYieldAttribution({
    snapshot: snapshot(15_150_000n, { deployedPrincipal: 5_000_000n, venueMarkedAssets: 5_030_000n }),
    events: [deposit(WALLET, 20_000_000), returned(3_100_000, 3_000_000), returned(2_070_000, 2_000_000, 21), writeOff(20_000),
      returned(9_000_000, 1_000_000, 41), writeOff(999_999, 42)],
    ledgerEntries: [{ ...subsidy, blockNumber: 41 }]
  });
  assert.equal(result.gain.venueEarned.raw, "180000", "100000 + 70000 - 20000 realised, plus 30000 outstanding mark");
  assert.equal(result.gain.cumulativeNav.raw, "180000");
  assert.equal(result.gain.unattributed.raw, "0");
  assert.equal(result.gain.operatorAdded.raw, "0");
  assert.equal(result.subsidyLedger.entryCount, 0);
  assertCloses(result);
});

test("cumulative capital still counts only deposits, withdrawals and operator principal", () => {
  const capital = [deposit(WALLET, 20_000_000), event("Withdraw", 2, { assetsRaw: "2000000", sharesRaw: "2000000" }),
    event("OperatorPrincipalContributed", 3, { assetsRaw: "3000000", sharesRaw: "3000000" })];
  const result = buildYieldAttribution({ snapshot: snapshot(21_098_235n), events: [
    ...capital, event("VenueDeploymentCreated", 10, { assetsRaw: "9980137" }),
    returned(5_150_000, 5_000_000), writeOff(30_000), writeOff(21_765, 26)
  ] });
  const baseline = buildYieldAttribution({ snapshot: snapshot(21_098_235n), events: capital });
  assert.deepEqual(result.basis, baseline.basis);
  assert.equal(result.basis.depositedCapital.raw, "20000000");
  assert.equal(result.basis.withdrawnCapital.raw, "2000000");
  assert.equal(result.basis.operatorPrincipal.raw, "3000000");
  assert.equal(result.basis.netShareBackedCapital.raw, "21000000");
  assert.equal(result.gain.venueEarned.raw, "98235");
  assert.equal(result.gain.unattributed.raw, "0");
});

test("unattested buffer gain offsetting realised loss is not falsely labelled the zero state", () => {
  const result = buildYieldAttribution({ snapshot: snapshot(20_000_000n), events: cycleOne });
  assert.equal(result.status, "partially_attributed");
  assert.equal(result.gain.venueEarned.raw, "-51765");
  assert.equal(result.gain.unattributed.raw, "51765");
  assert.equal(result.splitRatio.status, "not_applicable", "no ratio when cumulative gain is zero");
});

test("unreadable outstanding mark stays unavailable even when realised history is known", () => {
  const result = buildYieldAttribution({ snapshot: snapshot(15_000_000n, { deployedPrincipal: 5_000_000n }), events: cycleOne });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "venue_mark_unreadable");
  assert.equal(result.gain, undefined);
});
