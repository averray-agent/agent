import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHostedCanaryClaimantAttribution } from "../core/claimant-attribution.js";
import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import {
  TransparencyService,
  aggregateRawReadings,
  assertCacheFreshnessInvariant,
  derivePositionEconomics,
  deriveFieldStatus,
  remainingEscrowObligation,
  toField,
  worstStatus
} from "./transparency-service.js";

const WRAPPER = "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc";
const ESCROW = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
const TOKEN = "0x0000053900000000000000000000000001200000";
const TREASURY = "0x01E6eed856e989201F4FF6346E18EAb7e46C874C";
const TREASURY_ID = "0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47";
const CONVERTED = "0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const DEPOSIT_REQUEST = "0xeaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767";
const DEPOSIT_TX = "0x43a1cff204eb087872bdc7f5fa55ef74261cafd90863caee4720961b00e7d1af";
const LIVE_DEPOSIT_BACKFILL = JSON.parse(readFileSync(
  new URL("./fixtures/mainnet-bank-v221-10usdc-deposit-swap.json", import.meta.url),
  "utf8"
));

function depositCalibration(provenRaw = "10000000", overrides = {}) {
  return {
    provenRaw,
    provenAtMs: NOW - 60_000,
    provenSource: `erc20:${AUSDC}.balanceOf(${CONVERTED.slice(0, 42)})`,
    provenRequestId: DEPOSIT_REQUEST,
    provenWrapperAddress: WRAPPER.toLowerCase(),
    provenBlockNumber: 13_488_842,
    ...overrides
  };
}

function settlementReceipt(seed, workerAmountRaw) {
  return {
    txHash: `0x${seed.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    status: 1,
    settlement: {
      asset: TOKEN,
      assetSymbol: "USDC",
      workerAmountRaw
    }
  };
}

function job(overrides = {}) {
  return {
    state: 6,
    asset: TOKEN,
    rewardRaw: "1000000",
    releasedRaw: "1000000",
    opsReserveRaw: "0",
    contingencyReserveRaw: "0",
    protocolFeeRaw: "50000",
    protocolFeeReleasedRaw: "50000",
    ...overrides
  };
}

function harness(overrides = {}) {
  const definitions = new Map([
    ["external", { id: "external", source: { type: "external" } }],
    ["ingested", { id: "ingested", source: { type: "github_issue" } }],
    ["platform", { id: "platform" }],
    ["open", { id: "open" }]
  ]);
  const sessions = [
    {
      jobId: "external",
      status: "resolved",
      resolvedAt: "2026-08-06T11:00:00.000Z",
      payoutTx: settlementReceipt("external", "1000000")
    },
    {
      jobId: "ingested",
      status: "resolved",
      resolvedAt: "2026-08-06T10:00:00.000Z",
      payoutTx: settlementReceipt("ingested", "200000")
    },
    {
      jobId: "platform",
      status: "resolved",
      resolvedAt: "2026-08-06T09:00:00.000Z",
      payoutTx: settlementReceipt("platform", "100000")
    }
  ];
  if (overrides.sessionWallets) {
    for (const [index, wallet] of overrides.sessionWallets.entries()) {
      sessions[index].wallet = wallet;
    }
  }
  if (overrides.canarySessionIndex !== undefined) {
    sessions[overrides.canarySessionIndex].claimantAttribution = createHostedCanaryClaimantAttribution();
  }
  if (overrides.missingPayout) delete sessions[0].payoutTx;
  const chainJobs = new Map([
    ["external", job()],
    ["ingested", job({ rewardRaw: "200000", releasedRaw: "200000", protocolFeeRaw: "0", protocolFeeReleasedRaw: "0" })],
    ["platform", job({ rewardRaw: "100000", releasedRaw: "100000", protocolFeeRaw: "0", protocolFeeReleasedRaw: "0" })],
    ["open", job({
      state: 1,
      rewardRaw: "2000000",
      releasedRaw: "500000",
      opsReserveRaw: "10000",
      contingencyReserveRaw: "20000",
      protocolFeeRaw: "100000",
      protocolFeeReleasedRaw: "0"
    })]
  ]);
  const positionTarget = {
    ledger: "erc20",
    endpoint: "https://rpc.hydradx.cloud/",
    chainId: 222222,
    account: CONVERTED,
    accountTransform: "hydration_truncate20",
    contract: AUSDC
  };
  const floatTarget = {
    ledger: "substrate_tokens",
    endpoint: "wss://hydration-rpc.n.dwellir.com/",
    account: CONVERTED,
    assetId: 22
  };
  const options = {
    now: () => NOW,
    stateStore: {
      async listRecentSessions(limit, offset) {
        return sessions.slice(offset, offset + limit);
      },
      async getFundedJob(id) {
        return {
          sourceType: id === "external"
            ? "external"
            : id === "ingested"
              ? "github_issue"
          : "manual"
        };
      },
      async getLatestBankXcmLegDispatchEvidence(wrapper, leg) {
        assert.equal(wrapper, WRAPPER);
        assert.equal(leg, "deposit_sell");
        if (overrides.missingDepositEvent) return undefined;
        return overrides.depositEvent ?? LIVE_DEPOSIT_BACKFILL.event;
      }
    },
    platformService: {
      getJobDefinition(id) {
        if (!definitions.has(id)) throw new Error("missing definition");
        return definitions.get(id);
      },
      listJobs() {
        return [...definitions.values()];
      }
    },
    gateway: {
      config: {
        chainId: 420420419,
        rpcUrl: "https://services.polkadothub-rpc.com/mainnet/",
        xcmWrapperAddress: WRAPPER,
        escrowCoreAddress: ESCROW,
        supportedAssets: [{ symbol: "USDC", address: TOKEN, decimals: 6 }]
      },
      async getProtocolFeeConfig() {
        return { treasuryAccount: TREASURY };
      },
      async healthCheck() {
        if (overrides.failChainHead) throw new Error("rpc unreachable");
        if (overrides.chainHeadDisabled) return { ok: true, enabled: false, mode: "disabled" };
        return { ok: true, enabled: true, blockNumber: overrides.blockNumber ?? 9_218_453 };
      },
      async getJob(id) {
        if (overrides.failJob === id) throw new Error("job rpc failed");
        return chainJobs.get(id) ?? job({ state: 0 });
      },
      async getXcmRequest(id) {
        if (id !== DEPOSIT_REQUEST) throw new Error("unexpected request");
        return {
          requestId: id,
          queuedBy: "0x631A09913B2403b18b2b659a1397916621b29b4c",
          statusLabel: "succeeded",
          settledSharesRaw: overrides.settledSharesRaw ?? "10000000"
        };
      },
      async getHydrationAdapterRequest(id) {
        if (overrides.failCommitted) throw new Error("adapter request rpc failed");
        return { requestId: id, kind: 0, requestedAssetsRaw: "10050000" };
      }
    },
    venueBalanceReader: {
      async read(target) {
        if (String(target.account).toLowerCase() === TREASURY.toLowerCase()) {
          if (overrides.failTreasury) throw new Error("treasury rpc failed");
          return { raw: 878_804n, asOf: new Date(NOW).toISOString() };
        }
        if (String(target.account).toLowerCase() === ESCROW.toLowerCase()) {
          return { raw: 0n, asOf: new Date(NOW).toISOString() };
        }
        throw new Error("unexpected target");
      }
    },
    bankLaneFeed: {
      targets: {
        position: overrides.positionTarget ?? positionTarget,
        float: floatTarget
      },
      async getFeed() {
        return {
          position: overrides.positionReading ?? {
            raw: "10000000",
            source: "erc20:0x2ec4884088d84e5c2970a034732e5209b0acfa93.balanceOf(0x48df881b65e682f05ac24dc8f668a8938225e973)",
            readAtMs: NOW,
            lastError: null
          },
          float: {
            raw: "30000",
            source: `substrate_tokens:Tokens.accounts(${CONVERTED},22)`,
            readAtMs: NOW,
            lastError: null
          },
          subject: overrides.subject ?? {
            configuredWrapper: WRAPPER,
            uniqueArmedWrapper: WRAPPER,
            matches: true,
            status: "ok",
            reason: null,
            readAtMs: NOW,
            lastError: null,
            candidates: [{ version: "2.2.1", wrapper: WRAPPER, dispatchPaused: false, lastError: null }]
          },
          calibration: overrides.calibration === undefined
            ? depositCalibration()
            : overrides.calibration
        };
      }
    },
    selfIdentityRegistry: overrides.selfIdentityRegistry
  };
  if (!overrides.usePackagedTreasuryIdentity) {
    options.treasuryIdentity = { nativeAccountId32: TREASURY_ID, evmLens: TREASURY };
  }
  const service = new TransparencyService(options);
  return service;
}

test("field status is derived from evidence time and unknown never becomes zero", () => {
  assert.equal(deriveFieldStatus({ value: 1, readAtMs: 1_000 }, { nowMs: 1_500, freshnessWindowMs: 1_000 }), "fresh");
  assert.equal(deriveFieldStatus({ value: 1, readAtMs: 1_000 }, { nowMs: 2_001, freshnessWindowMs: 1_000 }), "stale");
  const unknown = toField({ value: null, unit: "USDC", readAtMs: 2_000, source: "rpc", proof: "failed" }, {
    nowMs: 2_000,
    freshnessWindowMs: 1_000
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.value, null);
  assert.notEqual(unknown.value, 0);
});

test("aggregates inherit the oldest evidence and refuse partial-unknown totals", () => {
  const reading = aggregateRawReadings([
    { raw: 10n, readAtMs: 1_000 },
    { raw: 5n, readAtMs: 1_500 }
  ], { source: "sum", proof: "parts" });
  assert.equal(reading.raw, 15n);
  assert.equal(reading.readAtMs, 1_000);
  const aggregate = toField({ ...reading, value: "15", unit: "USDC" }, { nowMs: 2_100, freshnessWindowMs: 1_000 });
  assert.equal(aggregate.status, "stale");
  assert.equal(worstStatus([{ status: "fresh" }, aggregate]), "stale");

  const partial = aggregateRawReadings([
    { raw: 10n, readAtMs: 1_000 },
    { raw: null, readAtMs: 1_500 }
  ], { source: "sum", proof: "parts" });
  assert.equal(partial.raw, null);
});

test("cache TTL must be strictly shorter than every freshness window", () => {
  assert.doesNotThrow(() => assertCacheFreshnessInvariant(999, { chain: 1_000 }));
  assert.throws(
    () => assertCacheFreshnessInvariant(1_000, { chain: 1_000 }),
    /strictly shorter/u
  );
});

test("transparency payload composes flow, escrow, and generation-bound treasury truth", async () => {
  const payload = await harness().getSnapshot();

  assert.equal(payload.schemaVersion, "averray.transparency.v1");
  assert.deepEqual(payload.flow.jobsSettled.last24h.value, 3);
  assert.equal(payload.flow.usdcPaid.last24h.value, "1.3");
  assert.equal(payload.flow.composition24h.platformVerificationRuns.value, 1);
  assert.equal(payload.flow.composition24h.ingested.value, 1);
  assert.equal(payload.flow.composition24h.external.value, 1);
  assert.equal(payload.escrow.posterObligationsInFlight.value, "1.63");
  assert.equal(payload.escrow.balanceHeldByEscrowContract.value, "0");
  assert.equal(payload.treasury.totalUsdcEquivalent.value, "10.908804");
  assert.equal(payload.treasury.lines.assetHubMultisig.balance.value, "0.878804");
  assert.equal(payload.treasury.lines.hydrationPosition.total.value, "10");
  assert.equal(payload.treasury.lines.operatingFloat.balance.value, "0.03");
  assert.equal(payload.treasury.position.deposited.value, "10");
  assert.equal(payload.treasury.position.positionNow.value, "10");
  assert.equal(payload.treasury.position.growth.value, "0");
  assert.equal(payload.treasury.position.frictionPaid.value, "0.02");
  assert.equal(payload.treasury.position.netVsCommitted.value, "-0.02");
  assert.match(payload.treasury.position.deposited.source, /Broadcast\.Swapped/u);
  assert.match(payload.treasury.position.deposited.proof, new RegExp(DEPOSIT_TX, "u"));
  assert.equal(payload.treasury.lines.hydrationPosition.principal.status, "unknown");
  assert.match(payload.treasury.lines.hydrationPosition.note.value, /cannot cleanly split/u);
  assert.equal(payload.treasury.generation.version.value, "2.2.1");
  assert.equal(payload.treasury.generation.state.value, "ok");
  assert.match(payload.treasury.lines.hydrationPosition.total.source, new RegExp(WRAPPER, "iu"));
  assert.match(payload.treasury.lines.assetHubMultisig.balance.proof, new RegExp(TREASURY_ID, "iu"));
});

test("transparency settlement flow uses the shared registry for ours, outsiders, and unknown", async () => {
  const external = "0x1111111111111111111111111111111111111111";
  const acceptance = "0x2222222222222222222222222222222222222222";
  const ephemeralCanary = "0x3333333333333333333333333333333333333333";
  const payload = await harness({
    sessionWallets: [external, acceptance, ephemeralCanary],
    canarySessionIndex: 2,
    selfIdentityRegistry: new SelfIdentityRegistry({ acceptanceWallets: [acceptance] })
  }).getSnapshot();

  assert.equal(payload.flow.workers24h.outsiders.value, 1);
  assert.equal(payload.flow.workers24h.ours.value, 2);
  assert.equal(payload.flow.workers24h.unknown.value, 0);
  assert.equal(payload.flow.workers24h.total.value, 3);
  assert.match(payload.flow.workers24h.ours.source, /shared self-identity registry/u);
});

test("mainnet treasury native AccountId32 resolves from the packaged custody record", async () => {
  const payload = await harness({ usePackagedTreasuryIdentity: true }).getSnapshot();

  assert.equal(payload.treasury.lines.assetHubMultisig.nativeAccountId32.value, TREASURY_ID);
  assert.equal(payload.treasury.lines.assetHubMultisig.evmLens.value, TREASURY);
  assert.match(payload.treasury.lines.assetHubMultisig.balance.proof, new RegExp(TREASURY_ID, "iu"));
});

test("live v2.2.1 deposit backfill resolves from the chain-observed Swapped3 event", async () => {
  const payload = await harness({
    depositEvent: LIVE_DEPOSIT_BACKFILL.event,
    settledSharesRaw: "10000001",
    positionReading: {
      raw: "10000844",
      source: "erc20:0x2ec4884088d84e5c2970a034732e5209b0acfa93.balanceOf(0x48df881b65e682f05ac24dc8f668a8938225e973)",
      readAtMs: NOW,
      lastError: null
    },
    calibration: depositCalibration("10000001")
  }).getSnapshot();

  assert.equal(payload.treasury.position.deposited.value, "10");
  assert.equal(payload.treasury.position.growth.value, "0.000844");
  assert.match(payload.treasury.position.deposited.source, /Hydration system\.events Broadcast\.Swapped3/u);
  assert.match(payload.treasury.position.deposited.proof, /hydration block 13488842/u);
  assert.match(payload.treasury.position.deposited.proof, /0xb9faf57d0a029ab/u);
});

test("position economics are real-read subtractions and preserve signed growth/net", () => {
  const reading = (raw, readAtMs = NOW) => ({ raw: BigInt(raw), readAtMs, source: "chain", proof: "chain" });
  const result = derivePositionEconomics({
    deposited: reading(10_000_000),
    positionNow: reading(10_000_596),
    committed: reading(10_050_000),
    floatRemaining: reading(29_776),
    configuredWrapper: WRAPPER
  });
  assert.equal(result.growth.raw, 596n);
  assert.equal(result.frictionPaid.raw, 20_224n);
  assert.equal(result.netVsCommitted.raw, -19_628n);
  assert.match(result.growth.source, /Broadcast\.Swapped/u);
  assert.doesNotMatch(result.growth.source, /adapter.*book/iu);
});

test("rebasing deposit corroboration accepts live +1 accrual without restoring equality", async () => {
  const payload = await harness({
    settledSharesRaw: "10000001",
    calibration: depositCalibration("10000001"),
    positionReading: {
      raw: "10000844",
      source: `erc20:${AUSDC}.balanceOf(${CONVERTED.slice(0, 42)})`,
      readAtMs: NOW,
      lastError: null
    }
  }).getSnapshot();

  assert.equal(payload.treasury.position.deposited.value, "10");
  assert.equal(payload.treasury.position.growth.value, "0.000844");
  assert.match(payload.treasury.position.deposited.proof, /settledShares 10000001/u);
});

test("rebasing deposit corroboration refuses settledShares below the swap output", async () => {
  const payload = await harness({ settledSharesRaw: "9999999" }).getSnapshot();
  assert.equal(payload.treasury.position.deposited.status, "unknown");
  assert.equal(payload.treasury.position.growth.status, "unknown");
  assert.match(payload.treasury.position.deposited.proof, /below the authoritative Broadcast\.Swapped deposit/u);
});

test("rebasing deposit corroboration refuses excess beyond the explicit two-bps bound", async () => {
  const payload = await harness({ settledSharesRaw: "10002001" }).getSnapshot();
  assert.equal(payload.treasury.position.deposited.status, "unknown");
  assert.equal(payload.treasury.position.netVsCommitted.status, "unknown");
  assert.match(payload.treasury.position.deposited.proof, /exceeds the 2-bps rebase corroboration bound/u);
});

test("rebasing deposit corroboration applies the same monotonic bound to calibration", async (t) => {
  await t.test("refuses a calibration below the swap output", async () => {
    const payload = await harness({ calibration: depositCalibration("9999999") }).getSnapshot();
    assert.equal(payload.treasury.position.deposited.status, "unknown");
    assert.match(payload.treasury.position.deposited.proof, /below the authoritative Broadcast\.Swapped deposit/u);
  });
  await t.test("refuses calibration excess beyond two bps", async () => {
    const payload = await harness({ calibration: depositCalibration("10002001") }).getSnapshot();
    assert.equal(payload.treasury.position.deposited.status, "unknown");
    assert.match(payload.treasury.position.deposited.proof, /exceeds the 2-bps rebase corroboration bound/u);
  });
});

test("missing or mismatched calibration is distinct from a genuinely low corroboration", async (t) => {
  await t.test("missing calibration names the missing-or-mismatched fault", async () => {
    const payload = await harness({ calibration: null }).getSnapshot();
    assert.equal(payload.treasury.position.deposited.status, "unknown");
    assert.match(payload.treasury.position.deposited.proof, /missing or mismatched/u);
    assert.doesNotMatch(payload.treasury.position.deposited.proof, /is below/u);
  });
  await t.test("a different deposit request names the missing-or-mismatched fault", async () => {
    const payload = await harness({
      calibration: depositCalibration("10000000", { provenRequestId: `0x${"ff".repeat(32)}` })
    }).getSnapshot();
    assert.equal(payload.treasury.position.deposited.status, "unknown");
    assert.match(payload.treasury.position.deposited.proof, /missing or mismatched/u);
    assert.doesNotMatch(payload.treasury.position.deposited.proof, /is below/u);
  });
  await t.test("a lower value still names the quantitative fault", async () => {
    const payload = await harness({ calibration: depositCalibration("9999999") }).getSnapshot();
    assert.match(payload.treasury.position.deposited.proof, /is below/u);
    assert.doesNotMatch(payload.treasury.position.deposited.proof, /missing or mismatched/u);
  });
});

test("missing deposited evidence makes growth and net unknown without adapter-book fallback", async () => {
  const payload = await harness({ missingDepositEvent: true }).getSnapshot();
  assert.equal(payload.treasury.position.deposited.status, "unknown");
  assert.equal(payload.treasury.position.growth.status, "unknown");
  assert.equal(payload.treasury.position.netVsCommitted.status, "unknown");
  assert.equal(payload.treasury.position.positionNow.value, "10");
  assert.doesNotMatch(payload.treasury.position.growth.source, /adapter.*book/iu);
});

test("adapter commitment failure keeps observed growth readable but friction and net unknown", async () => {
  const payload = await harness({ failCommitted: true }).getSnapshot();
  assert.equal(payload.treasury.position.growth.value, "0");
  assert.equal(payload.treasury.position.frictionPaid.status, "unknown");
  assert.equal(payload.treasury.position.netVsCommitted.status, "unknown");
});

test("a failed field becomes unknown without taking down the endpoint or poisoning totals", async () => {
  const payload = await harness({ failTreasury: true }).getSnapshot();
  assert.equal(payload.treasury.lines.assetHubMultisig.balance.value, null);
  assert.equal(payload.treasury.lines.assetHubMultisig.balance.status, "unknown");
  assert.equal(payload.treasury.totalUsdcEquivalent.value, null);
  assert.equal(payload.treasury.totalUsdcEquivalent.status, "unknown");
  assert.equal(payload.treasury.lines.hydrationPosition.total.value, "10");
});

test("a missing settlement receipt keeps the job count but makes paid USDC unknown", async () => {
  const payload = await harness({ missingPayout: true }).getSnapshot();
  assert.equal(payload.flow.jobsSettled.last24h.value, 3);
  assert.equal(payload.flow.usdcPaid.last24h.value, null);
  assert.equal(payload.flow.usdcPaid.last24h.status, "unknown");
  assert.match(payload.flow.usdcPaid.last24h.proof, /receipt/u);
});

test("configured-generation administrative pause is preserved as an honest third state", async () => {
  const payload = await harness({
    subject: {
      configuredWrapper: WRAPPER,
      uniqueArmedWrapper: null,
      matches: true,
      status: "paused",
      reason: "administratively_paused",
      readAtMs: NOW,
      lastError: null,
      candidates: [{ version: "2.2.1", wrapper: WRAPPER, dispatchPaused: true, lastError: null }]
    }
  }).getSnapshot();

  assert.equal(payload.treasury.generation.wrapperAddress.value, WRAPPER);
  assert.equal(payload.treasury.generation.version.value, "2.2.1");
  assert.equal(payload.treasury.generation.state.value, "paused");
  assert.equal(payload.treasury.generation.reason.value, "administratively_paused");
  assert.equal(payload.treasury.generation.state.status, "fresh");
});

test("pinned regression: the ORML asset-1003 aUSDC lens can never publish a confident zero", async () => {
  const wrongTarget = {
    ledger: "substrate_tokens",
    endpoint: "wss://hydration-rpc.n.dwellir.com/",
    account: CONVERTED,
    assetId: 1003
  };
  const payload = await harness({
    positionTarget: wrongTarget,
    positionReading: {
      raw: "0",
      source: `substrate_tokens:Tokens.accounts(${CONVERTED},1003)`,
      readAtMs: NOW,
      lastError: null
    }
  }).getSnapshot();
  assert.equal(payload.treasury.lines.hydrationPosition.total.value, null);
  assert.equal(payload.treasury.lines.hydrationPosition.total.status, "unknown");
  assert.match(payload.treasury.lines.hydrationPosition.total.proof, /ERC20 balanceOf/u);
});

test("escrow obligation includes all still-reserved poster balances", () => {
  assert.equal(remainingEscrowObligation({
    rewardRaw: "1000000",
    releasedRaw: "250000",
    protocolFeeRaw: "50000",
    protocolFeeReleasedRaw: "10000",
    opsReserveRaw: "20000",
    contingencyReserveRaw: "30000"
  }), 840000n);
});

test("chain head is published so a reading can name the block it came from", async () => {
  const payload = await harness().getSnapshot();
  assert.equal(payload.chain.head.value, 9_218_453);
  assert.equal(payload.chain.head.unit, "block");
  assert.equal(payload.chain.head.status, "fresh");
  assert.match(payload.chain.head.proof, /eth_blockNumber/u);
});

// A head that cannot be read must read as unknown. The public record page
// prints this number under every figure, so a remembered or invented head
// would attach false provenance to values that are themselves fine.
test("chain head is unknown rather than invented when the gateway cannot answer", async () => {
  const failed = await harness({ failChainHead: true }).getSnapshot();
  assert.equal(failed.chain.head.value, null);
  assert.equal(failed.chain.head.status, "unknown");

  const disabled = await harness({ chainHeadDisabled: true }).getSnapshot();
  assert.equal(disabled.chain.head.value, null);
  assert.equal(disabled.chain.head.status, "unknown");
});
