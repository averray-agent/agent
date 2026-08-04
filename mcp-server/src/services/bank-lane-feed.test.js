import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import {
  BANK_LANE_FEED_STATE_SCOPE,
  BankLaneFeedService,
  describeBalanceTarget,
  evaluateSoleArmedWrapper,
  loadBankLaneFeedConfig
} from "./bank-lane-feed.js";
import { normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const ACCOUNT = "0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4c4a25d432739218efd489736";
const RETIRED_ACCOUNT = "0x98f0033e26aa4ecf2899e6d09237d40d29fcb68e64d22a621520bde1123564ac";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const OTHER_AUSDC = "0x1111111111111111111111111111111111111111";
const POSTAGE = "1yKNU414vYDyXYXL6pu845puajfeGTezD1rBiUYwp9UKBaZ";
const ACCOUNT_SS58 = "141ujyV9aKBYqZncx6SYRWU2XQCxUcYiGYE8U7jprEKVUZNJ";
const WRAPPER_V20 = "0xc846eE73e49A748e59C7Ac8f8742F542a552D24C";
const WRAPPER_V21 = "0x2AF394fA95f75D3ca1C786128f4dfA1eB0c9675D";
const BASE = Date.parse("2026-08-03T14:00:00.000Z");

function subject(configuredWrapper = WRAPPER_V21) {
  return {
    configuredWrapper,
    candidates: [
      { version: "2.0", wrapper: WRAPPER_V20 },
      { version: "2.1", wrapper: WRAPPER_V21 }
    ]
  };
}

function targets(positionContract = AUSDC) {
  return {
    position: {
      ledger: "erc20",
      endpoint: "https://rpc.hydradx.cloud",
      chainId: 222222,
      account: ACCOUNT,
      accountTransform: "hydration_truncate20",
      contract: positionContract
    },
    float: {
      ledger: "substrate_tokens",
      endpoint: "wss://hydration-rpc.n.dwellir.com",
      account: ACCOUNT,
      assetId: 22
    },
    postage: {
      ledger: "substrate_system",
      endpoint: "wss://polkadot-asset-hub-rpc.polkadot.io",
      account: POSTAGE
    }
  };
}

function service(store, reader, options = {}) {
  return new BankLaneFeedService(store, reader, {
    enabled: true,
    subject: subject(),
    subjectReader: {
      async readDispatchPaused(wrapper) {
        return wrapper.toLowerCase() !== WRAPPER_V21.toLowerCase();
      }
    },
    targets: targets(),
    now: () => BASE,
    ...options
  });
}

test("Bank feed preserves raw decimal strings and each source's completion clock", async () => {
  const store = new MemoryStateStore();
  await store.upsertXcmBalanceWatch({
    requestId: `0x${"12".repeat(32)}`,
    status: "pending",
    kind: "deposit",
    phase: "recovery-pending",
    direction: "increase",
    startedAt: new Date(BASE - 125_000).toISOString(),
    deadlineAt: new Date(BASE - 1).toISOString()
  });
  const reads = {
    erc20: { raw: "900719925474099312345678", asOf: BASE - 3_000 },
    substrate_tokens: { raw: "28463", asOf: BASE - 2_000 },
    substrate_system: { raw: "15100000000", asOf: BASE - 1_000 }
  };
  const feed = await service(store, {
    async read(target) {
      return { ...reads[target.ledger], target };
    }
  }).pollOnce();

  assert.equal(feed.position.raw, "900719925474099312345678");
  assert.equal(feed.position.readAtMs, BASE - 3_000);
  assert.equal(feed.float.raw, "28463");
  assert.equal(feed.float.readAtMs, BASE - 2_000);
  assert.equal(feed.postage.raw, "15100000000");
  assert.equal(feed.postage.readAtMs, BASE - 1_000);
  assert.notEqual(feed.position.readAtMs, feed.float.readAtMs);
  assert.deepEqual(feed.requests.items, [{
    id: `0x${"12".repeat(32)}`,
    kind: "deposit",
    phase: "recovery-pending",
    ageSeconds: 125,
    overdue: true,
    status: "pending"
  }]);
  assert.equal(feed.requests.readAtMs, BASE);
  assert.equal(feed.requests.lastError, null);
  assert.deepEqual(feed.calibration, {
    provenAtMs: BASE - 3_000,
    provenRaw: "900719925474099312345678",
    provenSource: feed.position.source
  });
  assert.match(feed.position.source, /^erc20:0x2ec4884088d84e5c2970a034732e5209b0acfa93\.balanceOf\(0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4\)$/u);
});

test("completed sections advance while one source remains stale", async () => {
  const store = new MemoryStateStore();
  const positionSource = describeBalanceTarget(targets().position);
  await store.upsertServiceState(BANK_LANE_FEED_STATE_SCOPE, {
    position: {
      raw: "100000",
      source: positionSource,
      readAtMs: BASE - 40 * 60_000,
      lastError: null
    }
  });
  let releasePosition;
  const positionPending = new Promise((resolve) => { releasePosition = resolve; });
  const bankFeed = service(store, {
    async read(target) {
      if (target.ledger === "erc20") return positionPending;
      if (target.ledger === "substrate_tokens") {
        return { raw: "28463", asOf: BASE - 2_000, target };
      }
      return { raw: "15100000000", asOf: BASE - 1_000, target };
    }
  });

  const polling = bankFeed.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const partial = await bankFeed.getFeed();
  assert.equal(partial.position.readAtMs, BASE - 40 * 60_000);
  assert.equal(partial.float.readAtMs, BASE - 2_000);
  assert.equal(partial.postage.readAtMs, BASE - 1_000);

  releasePosition({ raw: "100001", asOf: BASE, target: targets().position });
  const complete = await polling;
  assert.equal(complete.position.readAtMs, BASE);
});

test("read failures expose lastError without coercing null to zero or unread requests to all-clear", async () => {
  const store = new MemoryStateStore();
  store.listPendingXcmBalanceWatches = async () => {
    throw new Error("request table unavailable at https://rpc.example/private?api_key=secret");
  };
  const feed = await service(store, {
    async read(target) {
      if (target.ledger === "erc20") {
        return { raw: null, asOf: BASE, target };
      }
      if (target.ledger === "substrate_system") {
        throw new Error("timeout at https://rpc.example/private?token=secret");
      }
      return { raw: "0", asOf: BASE, target };
    }
  }).pollOnce();

  assert.equal(feed.position.raw, null);
  assert.equal(feed.position.readAtMs, BASE);
  assert.match(feed.position.lastError, /invalid raw integer/u);
  assert.equal(feed.postage.raw, null);
  assert.match(feed.postage.lastError, /timeout at https:\/\/rpc\.example\/\[redacted\]/u);
  assert.doesNotMatch(feed.postage.lastError, /secret/u);
  assert.deepEqual(feed.requests.items, []);
  assert.equal(feed.requests.readAtMs, BASE);
  assert.match(feed.requests.lastError, /request table unavailable/u);
  assert.doesNotMatch(feed.requests.lastError, /secret/u);
  assert.equal(feed.float.raw, "0");
});

test("request snapshot never silently truncates the pending table", async () => {
  const store = new MemoryStateStore();
  for (let index = 0; index < 125; index += 1) {
    await store.upsertXcmBalanceWatch({
      requestId: `0x${index.toString(16).padStart(64, "0")}`,
      status: "pending",
      direction: "increase",
      startedAt: new Date(BASE - index * 1_000).toISOString(),
      deadlineAt: new Date(BASE + 60_000).toISOString()
    });
  }
  const feed = await service(store, {
    async read(target) { return { raw: "0", asOf: BASE, target }; }
  }).pollOnce();

  assert.equal(feed.requests.items.length, 125);
  assert.equal(feed.requests.lastError, null);
});

test("terminal request exposes the honest reconciliation without presenting the v2.1 raw slot as a receivable", async () => {
  const store = new MemoryStateStore();
  const requestId = `0x${"42".repeat(32)}`;
  await store.upsertXcmBalanceWatch({
    requestId,
    status: "failed",
    kind: "deposit",
    phase: "terminal",
    startedAt: new Date(BASE - 30 * 60_000).toISOString(),
    deadlineAt: new Date(BASE - 15 * 60_000).toISOString(),
    completedAt: new Date(BASE - 5 * 60_000).toISOString(),
    reconciliation: {
      stagedRaw: "150000",
      actualTreasuryReturnRaw: "130200",
      leg1TransferFeeRaw: "525",
      trappedWriteOff3Raw: "17932",
      recoveryReturnFeeRaw: "1343",
      unexplainedRaw: "0",
      finalRawRecoverySlotResidueRaw: "19800",
      artifactLabel: "v2.1 accounting artifact, known-unrecoverable",
      rawRecoveryAssetsOutstandingRaw: "150000"
    }
  });

  const feed = await service(store, {
    async read(target) { return { raw: "0", asOf: BASE, target }; }
  }).pollOnce();

  assert.deepEqual(feed.requests.items, [{
    id: requestId,
    kind: "deposit",
    phase: "terminal",
    ageSeconds: 1800,
    overdue: false,
    status: "failed",
    reconciliation: {
      stagedRaw: "150000",
      actualTreasuryReturnRaw: "130200",
      leg1TransferFeeRaw: "525",
      trappedWriteOff3Raw: "17932",
      recoveryReturnFeeRaw: "1343",
      unexplainedRaw: "0",
      finalRawRecoverySlotResidueRaw: "19800",
      artifactLabel: "v2.1 accounting artifact, known-unrecoverable"
    }
  }]);
  assert.equal("rawRecoveryAssetsOutstandingRaw" in feed.requests.items[0].reconciliation, false);
});

test("request snapshot excludes the retired v2.0 venue target without hiding unknown work", async () => {
  const store = new MemoryStateStore();
  const request = (requestId, target) => store.upsertXcmBalanceWatch({
    requestId,
    status: "pending",
    target,
    direction: "increase",
    startedAt: new Date(BASE - 10_000).toISOString(),
    deadlineAt: new Date(BASE + 60_000).toISOString()
  });
  await request(`0x${"10".repeat(32)}`, {
    ...targets().position,
    account: RETIRED_ACCOUNT
  });
  await request(`0x${"20".repeat(32)}`, targets().position);
  await request(`0x${"30".repeat(32)}`, undefined);

  const feed = await service(store, {
    async read(target) { return { raw: "0", asOf: BASE, target }; }
  }).pollOnce();

  assert.deepEqual(feed.requests.items.map(({ id }) => id), [
    `0x${"20".repeat(32)}`,
    `0x${"30".repeat(32)}`
  ]);
  assert.equal(feed.requests.lastError, null);
});

test("position calibration requires non-zero, survives restart, and invalidates on retarget", async () => {
  const store = new MemoryStateStore();
  let positionRaw = "0";
  let positionAsOf = BASE;
  const reader = {
    async read(target) {
      const raw = target.ledger === "erc20" ? positionRaw : "0";
      return { raw, asOf: positionAsOf, target };
    }
  };
  const firstProcess = service(store, reader);
  assert.equal((await firstProcess.pollOnce()).calibration, null);

  positionRaw = "100000";
  positionAsOf = BASE + 1_000;
  const proven = await firstProcess.pollOnce();
  assert.deepEqual(proven.calibration, {
    provenAtMs: BASE + 1_000,
    provenRaw: "100000",
    provenSource: proven.position.source
  });

  positionRaw = "200000";
  positionAsOf = BASE + 2_000;
  await firstProcess.pollOnce();
  const restarted = service(store, reader);
  assert.deepEqual((await restarted.getFeed()).calibration, proven.calibration);

  positionRaw = "0";
  const retargeted = service(store, reader, { targets: targets(OTHER_AUSDC) });
  const beforeRetargetRead = await retargeted.getFeed();
  assert.equal(beforeRetargetRead.position.raw, null);
  assert.equal(beforeRetargetRead.calibration, null);
  assert.equal((await retargeted.pollOnce()).calibration, null);
});

test("Bank feed config binds the three exact ledgers and stays inert when disabled", () => {
  assert.deepEqual(loadBankLaneFeedConfig({ BANK_LANE_FEED_ENABLED: "false" }), {
    enabled: false
  });
  const config = loadBankLaneFeedConfig({
    BANK_LANE_FEED_ENABLED: "true",
    XCM_WRAPPER_ADDRESS: WRAPPER_V21,
    BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON: JSON.stringify(subject().candidates),
    BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32: ACCOUNT,
    BANK_LANE_FEED_HYDRATION_EVM_RPC_URL: "https://rpc.hydradx.cloud",
    BANK_LANE_FEED_HYDRATION_EVM_CHAIN_ID: "222222",
    BANK_LANE_FEED_AUSDC_CONTRACT: AUSDC,
    BANK_LANE_FEED_HYDRATION_SUBSTRATE_RPC_URL: "wss://hydration-rpc.n.dwellir.com",
    BANK_LANE_FEED_FLOAT_ASSET_ID: "22",
    BANK_LANE_FEED_POSTAGE_SUBSTRATE_RPC_URL: "wss://polkadot-asset-hub-rpc.polkadot.io",
    BANK_LANE_FEED_POSTAGE_ACCOUNT: POSTAGE
  });

  assert.equal(config.targets.position.ledger, "erc20");
  assert.equal(config.targets.position.accountTransform, "hydration_truncate20");
  assert.equal(config.targets.float.ledger, "substrate_tokens");
  assert.equal(config.targets.float.assetId, "22");
  assert.equal(config.targets.postage.ledger, "substrate_system");
  assert.equal(config.targets.postage.account, POSTAGE);
  assert.equal(config.subject.configuredWrapper, WRAPPER_V21);
  assert.deepEqual(config.subject.candidates, subject().candidates);
  assert.throws(
    () => loadBankLaneFeedConfig({
      BANK_LANE_FEED_ENABLED: "true",
      XCM_WRAPPER_ADDRESS: WRAPPER_V21,
      BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON: JSON.stringify(subject().candidates)
    }),
    /BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32 is required/u
  );
});

test("sole-armed-wrapper subject reports the configured wrapper only from live paused bits", async () => {
  const store = new MemoryStateStore();
  const feed = await service(store, {
    async read(target) { return { raw: "0", asOf: BASE, target }; }
  }).pollOnce();

  assert.deepEqual(feed.subject, {
    configuredWrapper: WRAPPER_V21,
    uniqueArmedWrapper: WRAPPER_V21,
    matches: true,
    status: "ok",
    candidates: [
      { version: "2.0", wrapper: WRAPPER_V20, dispatchPaused: true, lastError: null },
      { version: "2.1", wrapper: WRAPPER_V21, dispatchPaused: false, lastError: null }
    ],
    readAtMs: BASE,
    lastError: null
  });
});

test("sole-armed-wrapper subject fails when env points at a recorded but retired wrapper", () => {
  const result = evaluateSoleArmedWrapper({
    configuredWrapper: WRAPPER_V20,
    candidates: [
      { version: "2.0", wrapper: WRAPPER_V20, dispatchPaused: true },
      { version: "2.1", wrapper: WRAPPER_V21, dispatchPaused: false }
    ],
    readAtMs: BASE
  });
  assert.equal(result.status, "error");
  assert.equal(result.matches, false);
  assert.equal(result.uniqueArmedWrapper, WRAPPER_V21);
  assert.equal(result.lastError, "configured_wrapper_not_unique_armed_wrapper");
});

test("sole-armed-wrapper subject fails on zero or multiple armed generations", () => {
  const candidate = (wrapper, dispatchPaused) => ({ version: wrapper, wrapper, dispatchPaused });
  const none = evaluateSoleArmedWrapper({
    configuredWrapper: WRAPPER_V21,
    candidates: [candidate(WRAPPER_V20, true), candidate(WRAPPER_V21, true)],
    readAtMs: BASE
  });
  assert.equal(none.status, "error");
  assert.equal(none.matches, false);
  assert.equal(none.lastError, "no_armed_wrapper");

  const multiple = evaluateSoleArmedWrapper({
    configuredWrapper: WRAPPER_V21,
    candidates: [candidate(WRAPPER_V20, false), candidate(WRAPPER_V21, false)],
    readAtMs: BASE
  });
  assert.equal(multiple.status, "error");
  assert.equal(multiple.matches, false);
  assert.equal(multiple.lastError, "multiple_armed_wrappers");
});

test("sole-armed-wrapper subject is unknown rather than green when any paused bit is unreadable", () => {
  const result = evaluateSoleArmedWrapper({
    configuredWrapper: WRAPPER_V21,
    candidates: [
      { version: "2.0", wrapper: WRAPPER_V20, dispatchPaused: null, lastError: "rpc timeout" },
      { version: "2.1", wrapper: WRAPPER_V21, dispatchPaused: false }
    ],
    readAtMs: BASE
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.matches, null);
  assert.equal(result.uniqueArmedWrapper, null);
  assert.equal(result.lastError, "wrapper_pause_state_unverified");
});

test("stored subject from a prior env generation is invalidated instead of reused", async () => {
  const store = new MemoryStateStore();
  await store.upsertServiceState(BANK_LANE_FEED_STATE_SCOPE, {
    subject: evaluateSoleArmedWrapper({
      configuredWrapper: WRAPPER_V20,
      candidates: [
        { version: "2.0", wrapper: WRAPPER_V20, dispatchPaused: false },
        { version: "2.1", wrapper: WRAPPER_V21, dispatchPaused: true }
      ],
      readAtMs: BASE - 1_000
    })
  });
  const current = await service(store, {
    async read(target) { return { raw: "0", asOf: BASE, target }; }
  }).getFeed();
  assert.equal(current.subject.status, "unknown");
  assert.equal(current.subject.matches, null);
  assert.equal(current.subject.configuredWrapper, WRAPPER_V21);
  assert.equal(current.subject.lastError, "subject_snapshot_missing_or_stale");
});

test("mainnet template ships the Bank feed ENABLED, with targets that match the deployment manifest", async () => {
  const [template, manifestRaw] = await Promise.all([
    readFile(new URL("../../../deploy/backend.mainnet.env.template", import.meta.url), "utf8"),
    readFile(new URL("../../../deployments/mainnet.json", import.meta.url), "utf8")
  ]);
  const env = Object.fromEntries(template
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const manifest = JSON.parse(manifestRaw);
  // The lane is on in the SHIPPED template as of #929. The template is the only
  // control surface there is: render-vps-env.sh op-injects it straight into
  // /run/agent-stack-mainnet/backend.env with no override layer, so "explicit
  // enablement" is this line and nothing else.
  assert.equal(env.BANK_LANE_FEED_ENABLED, "true");
  // Loaded from the template AS-IS — deliberately no in-test override. This now
  // asserts that the file an operator actually deploys produces a working
  // config, rather than that it would if someone flipped a flag first.
  const config = loadBankLaneFeedConfig(env);
  const strategy = manifest.strategies.find((item) => item.id === "HYDRATION_USDC_V1");

  assert.equal(env.BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32, ACCOUNT_SS58);
  assert.equal(config.enabled, true);
  assert.equal(config.targets.position.account, ACCOUNT_SS58);
  assert.equal(
    normalizeVenueBalanceTarget(config.targets.position).account,
    manifest.bankXcmV2Deployment.convertedAccountId32
  );
  assert.equal(
    normalizeVenueBalanceTarget(config.targets.float).account,
    manifest.bankXcmV2Deployment.convertedAccountId32
  );
  assert.equal(
    describeBalanceTarget(config.targets.position),
    `erc20:${strategy.remote.aUsdcContract}.balanceOf(0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4)`
  );
  assert.equal(config.targets.position.contract, strategy.remote.aUsdcContract);
  assert.equal(config.targets.float.assetId, String(strategy.remote.assetId));
  assert.equal(config.targets.postage.account, POSTAGE);
  assert.equal(env.XCM_WRAPPER_ADDRESS, manifest.contracts.xcmWrapper);
  assert.equal(env.BANK_XCM_FLOW_ENABLED, "false", "dust proof does not arm automated dispatch");
});
