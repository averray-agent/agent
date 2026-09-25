import test from "node:test";
import assert from "node:assert/strict";
import { BankXcmV22Runtime } from "./bank-xcm-v22-runtime.js";
import { SubstrateSubsidyReader } from "./substrate-subsidy-reader.js";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { PlatformService } from "../core/platform-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { createPublicMetadataRoutes } from "../protocols/http/public-metadata-routes.js";

const ADDRESS = `0x${"11".repeat(20)}`;
const HASH = `0x${"22".repeat(32)}`;
const header = { number: { toNumber: () => 10 }, hash: { toHex: () => HASH } };
const target = { ledger: "substrate_tokens", endpoint: "wss://fixture.invalid", account: HASH, assetId: "22" };

function fixture() {
  const at = { query: {
    timestamp: { now: async () => 1_000_000n },
    system: { events: async () => [] },
    tokens: { accounts: async () => ({ toJSON: () => ({ free: "1" }) }) }
  } };
  const api = () => ({
    rpc: { chain: {
      getHeader: async () => header,
      getBlockHash: async () => HASH,
      getFinalizedHead: async () => HASH,
      getBlock: async () => ({ block: { header: { number: 10 }, extrinsics: [{ hash: HASH }] } })
    } },
    query: { timestamp: { now: async () => 1_000_000n } },
    at: async () => at,
    tx: { revive: { call: () => ({}) } },
    call: {
      reviveApi: { accountId: async () => ({ toHex: () => HASH }) },
      dryRunApi: { dryRunCall: async () => ({ toJSON: () => ({ ok: {
        executionResult: { ok: {} },
        forwardedXcms: [[{ v5: { interior: { x1: [{ parachain: 2034 }] } } }, [{ v5: [] }]]]
      } }) }), dryRunXcm: async () => ({}) },
      xcmPaymentApi: { queryXcmWeight: async () => ({}), queryDeliveryFees: async () => ({}) }
    }
  });
  const hub = api(), hydration = api();
  const runtime = Object.assign(Object.create(BankXcmV22Runtime.prototype), {
    wrapperAddress: ADDRESS,
    gateway: { signer: { getAddress: async () => ADDRESS } },
    getAssetHubApi: async () => hub,
    getHydrationApi: async () => hydration,
    previewLeg: async () => ({ message: "0x050400" }),
    encodeDispatch: () => "0x1234",
    balanceReader: { getSubstrateApi: async () => hub }
  });
  let started = 0;
  const rejectRead = () => { started += 1; return Promise.reject(new Error("earlier read failed")); };
  return { hub, hydration, at, runtime, rejectRead, started: () => started };
}

async function contained(run, started) {
  const unhandled = [];
  const listener = (error) => unhandled.push(error.message);
  process.on("unhandledRejection", listener);
  try {
    await assert.rejects(run);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(started() > 0, "the earlier asynchronous read must actually start");
    assert.deepEqual(unhandled, [], "batch failures must all have rejection handlers");
  } finally { process.off("unhandledRejection", listener); }
}

for (const [name, configure, run] of [
  ["remote fee runtime APIs", (f) => { f.hydration.rpc.chain.getHeader = f.rejectRead; delete f.hydration.call.xcmPaymentApi; },
    (f) => f.runtime.quoteRemoteFee({ requestId: HASH, leg: 2 })],
  ["home fee runtime APIs", (f) => { f.hub.rpc.chain.getHeader = f.rejectRead; delete f.hydration.call.dryRunApi; },
    (f) => f.runtime.quoteHomeExecutionFee({ requestId: HASH, leg: 3 })],
  ["funding fee source runtime APIs", (f) => { f.hub.rpc.chain.getHeader = f.rejectRead; delete f.hub.query.timestamp; },
    (f) => f.runtime.readFundingTransferFee({ requestId: HASH })],
  ["funding fee destination runtime APIs", (f) => { f.hydration.rpc.chain.getHeader = f.rejectRead; delete f.hub.call.xcmPaymentApi; },
    (f) => f.runtime.readFundingTransferFee({ requestId: HASH })],
  ["message dry-run runtime API", (f) => { f.hub.rpc.chain.getHeader = f.rejectRead; delete f.hub.call.dryRunApi; },
    (f) => f.runtime.dryRunMessage({ requestId: HASH, leg: 2, feeAmount: 1n })],
  ["queued event timestamp API", (f) => {
    f.hub.rpc.chain.getHeader = f.rejectRead; delete f.at.query.timestamp;
    f.runtime.wrapperInterface = { parseLog: () => ({ name: "RequestQueued", args: { requestId: HASH } }) };
    f.at.query.system.events = async () => [{ phase: { isApplyExtrinsic: true, asApplyExtrinsic: 0 },
      event: { section: "revive", method: "ContractEmitted", data: [ADDRESS, "0x", []] } }];
  },
    (f) => f.runtime.readRequestQueuedEventsAtHash(f.hub, HASH)],
  ["stamped token balance API", (f) => { f.at.query.timestamp.now = f.rejectRead; delete f.at.query.tokens; },
    (f) => f.runtime.readStampedBalance(target)],
  ["stamped EVM balance construction and read", (f) => {
    f.runtime.balanceReader.getEvmProvider = () => ({ getBlockNumber: async () => 10, getBlock: f.rejectRead,
      call: () => { throw new Error("later balance read failed"); } });
  }, (f) => f.runtime.readStampedBalance({ ledger: "erc20", endpoint: "https://fixture.invalid", account: ADDRESS, contract: ADDRESS })]
]) {
  test(`read batch contains sibling failures: ${name}`, async () => {
    const f = fixture(); configure(f);
    await contained(() => run(f), f.started);
  });
}

for (const [name, configure] of [
  ["subsidy block hashes", (f) => { f.hub.rpc.chain.getBlockHash = f.rejectRead; delete f.hub.rpc.chain.getFinalizedHead; }],
  ["subsidy block and finality", (f) => { f.hub.rpc.chain.getBlock = f.rejectRead; delete f.hub.rpc.chain.getHeader; }],
  ["subsidy events and timestamp", (f) => {
    f.hub.rpc.chain.getHeader = async () => ({ number: 11 });
    f.at.query.system.events = f.rejectRead; delete f.at.query.timestamp;
  }]
]) {
  test(`read batch contains sibling failures: ${name}`, async () => {
    const f = fixture(); configure(f);
    const reader = new SubstrateSubsidyReader({ balanceReader: f.runtime.balanceReader, endpoint: target.endpoint });
    await contained(() => reader.read({ extrinsicHash: HASH, blockNumber: 10, poolAddress: ADDRESS }), f.started);
  });
}

test("read batch contains sibling failures: treasury strategy policy dependency", async () => {
  let started = 0;
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.provider = { call: async () => { started += 1; throw new Error("earlier read failed"); } };
  gateway.policyContract = undefined;
  await contained(() => gateway.readTreasuryStrategyLane({ strategyId: HASH, adapter: ADDRESS, blockTag: 10 }), () => started);
});

test("read batch contains sibling failures: synchronous recurring status", async () => {
  let started = 0;
  const service = Object.assign(Object.create(PlatformService.prototype), {
    refreshExternalPostingClaimability: async () => {},
    jobCatalogService: { listJobs: () => [], getRecurringTemplateStatus: () => { throw new Error("later status read failed"); } },
    blockchainGateway: { getTreasuryPolicyStatus: async () => { started += 1; throw new Error("earlier read failed"); },
      isEnabled: () => { throw new Error("policy status unavailable"); } },
    jobExecutionService: { listRecentSessions: async () => [] },
    stateStore: new MemoryStateStore()
  });
  await contained(() => service.getAdminStatus(), () => started);
});

test("read batch contains sibling failures: synchronous onboarding capability", async () => {
  let started = 0;
  const route = createPublicMetadataRoutes({
    posterOnboardingService: {
      getWorkerDoorOnboarding: async () => { started += 1; throw new Error("earlier read failed"); },
      getExternalBountiesOnboarding: async () => ({})
    },
    idleBalanceConsentService: { getCapability: () => { throw new Error("later capability read failed"); } }
  });
  await contained(() => route({ request: { method: "GET" }, response: {}, pathname: "/onboarding" }), () => started);
});
