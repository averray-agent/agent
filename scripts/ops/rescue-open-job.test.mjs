import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Interface, getAddress } from "ethers";

import {
  MIN_OPEN_AGE_SECONDS,
  REASON_OPERATOR_RESCUE,
  TOMBSTONE_DOCUMENT_PATH,
  assertFinalizeEligible,
  assertPrepareEligible,
  buildCallPlan,
  buildPlanHash,
  hashTombstoneDocument,
  parseArgs,
  refundableTotal,
  resolveEscrowTarget,
  runRescue,
  validateArgs
} from "./rescue-open-job.mjs";

const JOB_ID = `0x${"11".repeat(32)}`;
const PLAN_HASH = `0x${"22".repeat(32)}`;
const TOMBSTONE_HASH = `0x${"33".repeat(32)}`;
const WRONG_HASH = `0x${"44".repeat(32)}`;
const ESCROW = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
const LEGACY_ESCROW = "0x9cCd1DbBB5C354CC6218e55D3cE924A4d631C035";
const POSTER = "0x089a0A57D001bACb8473161e007F0bAbC1768CeE";
const JANITOR = "0x1000000000000000000000000000000000000001";
const OTHER_WORKER = "0x2000000000000000000000000000000000000002";
const SIGNER = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const TOKEN = "0x0000053900000000000000000000000001200000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const JOB_ABI = [
  "function setOnboardingWaiverEligible(bytes32 jobId,bool eligible)",
  "function claimJobFor(bytes32 jobId,address worker)",
  "function submitWorkFor(bytes32 jobId,address worker,bytes32 evidenceHash)",
  "function resolveSinglePayout(bytes32 jobId,bool approved,bytes32 reasonCode,string metadataURI,bytes32 reasoningHash)",
  "function finalizeRejectedJob(bytes32 jobId)"
];
const iface = new Interface(JOB_ABI);

function args(overrides = {}) {
  return {
    profile: "mainnet",
    escrow: "current",
    phase: "prepare",
    jobId: JOB_ID,
    janitor: JANITOR,
    expectedSigner: SIGNER,
    expectedPlanHash: undefined,
    signerSecretRef: undefined,
    useKms: false,
    execute: false,
    resume: false,
    confirm: undefined,
    minOpenAgeSeconds: MIN_OPEN_AGE_SECONDS,
    help: false,
    ...overrides
  };
}

function job(overrides = {}) {
  return {
    poster: POSTER,
    worker: ZERO_ADDRESS,
    asset: TOKEN,
    reward: 1_000_000n,
    opsReserve: 20_000n,
    contingencyReserve: 30_000n,
    released: 0n,
    claimExpiry: 0n,
    claimStake: 0n,
    claimFee: 0n,
    claimEconomicsWaived: false,
    rejectedAt: 0n,
    payoutMode: 0,
    state: 1,
    protocolFee: 50_000n,
    protocolFeeReleased: 0n,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    job: job(),
    claimTtl: 86_400n,
    workerClaimCount: 0n,
    waiverEligible: false,
    waiverClaimCount: 3n,
    latestEvidence: `0x${"00".repeat(32)}`,
    disputeWindow: 604_800n,
    paused: false,
    signerIsSettlementBroker: true,
    signerIsVerifier: true,
    chainTimestamp: 1_700_010_000,
    chainBlock: 18_000_000,
    openAgeSeconds: 10_000,
    creation: { blockNumber: 17_900_000 },
    posterPosition: { liquid: 0n, reserved: 1_100_000n },
    rescueRejection: undefined,
    ...overrides
  };
}

test("parseArgs defaults to a secret-free prepare dry-run", () => {
  const parsed = parseArgs([
    "--profile", "mainnet",
    "--job-id", JOB_ID,
    "--janitor", JANITOR
  ]);
  assert.equal(parsed.execute, false);
  assert.equal(parsed.phase, "prepare");
  assert.equal(parsed.escrow, "current");
  assert.equal(parsed.minOpenAgeSeconds, 3_600);
});

test("refusal: execute requires an explicit job ID", () => {
  assert.throws(
    () => validateArgs(args({ jobId: undefined, execute: true })),
    /explicit 32-byte hex job ID/u
  );
});

test("refusal: execute requires a reviewed plan hash", () => {
  assert.throws(
    () => validateArgs(args({ execute: true, useKms: true, confirm: `RESCUE ${JOB_ID}` })),
    /expected-plan-hash/u
  );
});

test("refusal: execute requires the exact job-specific typed confirmation", () => {
  assert.throws(
    () => validateArgs(args({ execute: true, useKms: true, expectedPlanHash: PLAN_HASH, confirm: "RESCUE wrong" })),
    new RegExp(`RESCUE ${JOB_ID}`, "u")
  );
});

test("refusal: signer backends are mutually exclusive", () => {
  assert.throws(
    () => validateArgs(args({ useKms: true, signerSecretRef: "op://vault/item/key" })),
    /exactly one signer backend/u
  );
});

test("refusal: the one-hour Open safety floor cannot be lowered", () => {
  assert.throws(
    () => validateArgs(args({ minOpenAgeSeconds: 3_599 })),
    /cannot be lower/u
  );
});

test("manifest target resolution keeps current and legacy escrows explicit", () => {
  const manifest = {
    contracts: { escrowCore: ESCROW, legacyEscrowCore: LEGACY_ESCROW },
    deploymentBlocks: { escrowCore: 100, escrowCoreV2: 200 }
  };
  assert.deepEqual(resolveEscrowTarget(manifest, "current"), {
    contractKey: "escrowCore",
    address: getAddress(ESCROW),
    deploymentKey: "escrowCoreV2",
    deploymentBlock: 200
  });
  assert.deepEqual(resolveEscrowTarget(manifest, "legacy"), {
    contractKey: "legacyEscrowCore",
    address: getAddress(LEGACY_ESCROW),
    deploymentKey: "escrowCore",
    deploymentBlock: 100
  });
});

test("prepare plan encodes waiver, janitor claim, tombstone submit, rejection, and no payout", () => {
  const calls = buildCallPlan({
    phase: "prepare",
    jobId: JOB_ID,
    janitor: JANITOR,
    escrowAddress: ESCROW,
    tombstoneHash: TOMBSTONE_HASH,
    waiverEligible: false,
    state: 1
  });
  assert.deepEqual(calls.map((call) => call.functionName), [
    "setOnboardingWaiverEligible",
    "claimJobFor",
    "submitWorkFor",
    "resolveSinglePayout"
  ]);
  const rejection = iface.decodeFunctionData("resolveSinglePayout", calls[3].data);
  assert.equal(rejection[0], JOB_ID);
  assert.equal(rejection[1], false);
  assert.equal(rejection[2], REASON_OPERATOR_RESCUE);
  assert.equal(rejection[4], TOMBSTONE_HASH);
  assert.ok(calls.every((call) => call.to === ESCROW && call.value === 0n));
});

test("prepare plan does not repeat an already-live waiver flag", () => {
  const calls = buildCallPlan({
    phase: "prepare",
    jobId: JOB_ID,
    janitor: JANITOR,
    escrowAddress: ESCROW,
    tombstoneHash: TOMBSTONE_HASH,
    waiverEligible: true,
    state: 1
  });
  assert.deepEqual(calls.map((call) => call.functionName), [
    "claimJobFor",
    "submitWorkFor",
    "resolveSinglePayout"
  ]);
});

test("refusal: ordinary non-Open jobs cannot enter prepare", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ job: job({ state: 2, worker: OTHER_WORKER }) }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /requires Open/u
  );
});

test("refusal: a young Open job cannot be rescued", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ openAgeSeconds: 3_599 }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /minimum rescue safety floor/u
  );
});

test("refusal: zero claim TTL cannot enter the tombstone lifecycle", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ claimTtl: 0n }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /claimTtls\(jobId\) is zero/u
  );
});

test("refusal: milestone payout jobs are outside this runbook", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ job: job({ payoutMode: 1 }) }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /Single payout jobs only/u
  );
});

test("refusal: prepare signer must have both broker and verifier roles", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ signerIsVerifier: false }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /both settlementBroker and verifier/u
  );
});

test("refusal: janitor cannot be the recorded poster", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ job: job({ poster: JANITOR }) }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /distinct from the recorded poster/u
  );
});

test("refusal: exhausted waiver headroom never falls back to paid economics", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({ workerClaimCount: 3n, waiverClaimCount: 3n }), {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /waiver headroom exhausted/u
  );
});

test("refusal: resume cannot adopt another worker's claim", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({
      job: job({ state: 2, worker: OTHER_WORKER, claimEconomicsWaived: true, claimExpiry: 1_700_020_000n })
    }), {
      janitor: JANITOR,
      resume: true,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /different worker/u
  );
});

test("refusal: resume rejects non-waived partial economics", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({
      workerClaimCount: 3n,
      job: job({ state: 2, worker: JANITOR, claimEconomicsWaived: false, claimExpiry: 1_700_020_000n })
    }), {
      janitor: JANITOR,
      resume: true,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /not fully waiver-backed/u
  );
});

test("refusal: resume rejects a Submitted job with different evidence", () => {
  assert.throws(
    () => assertPrepareEligible(snapshot({
      job: job({ state: 3, worker: JANITOR, claimEconomicsWaived: true }),
      latestEvidence: WRONG_HASH
    }), {
      janitor: JANITOR,
      resume: true,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /not the canonical/u
  );
});

test("resume emits only the missing calls for a canonical Submitted rescue", () => {
  const partial = snapshot({
    job: job({ state: 3, worker: JANITOR, claimEconomicsWaived: true }),
    latestEvidence: TOMBSTONE_HASH
  });
  assert.doesNotThrow(() => assertPrepareEligible(partial, {
    janitor: JANITOR,
    resume: true,
    tombstoneHash: TOMBSTONE_HASH
  }));
  const calls = buildCallPlan({
    phase: "prepare",
    jobId: JOB_ID,
    janitor: JANITOR,
    escrowAddress: ESCROW,
    tombstoneHash: TOMBSTONE_HASH,
    waiverEligible: true,
    state: 3,
    resume: true
  });
  assert.deepEqual(calls.map((call) => call.functionName), ["resolveSinglePayout"]);
});

test("refusal: finalization requires the Rejected state", () => {
  assert.throws(
    () => assertFinalizeEligible(snapshot(), { janitor: JANITOR, tombstoneHash: TOMBSTONE_HASH }),
    /requires Rejected/u
  );
});

test("refusal: finalization requires the canonical tombstone and rescue reason event", () => {
  const rejected = snapshot({
    job: job({ state: 4, worker: JANITOR, claimEconomicsWaived: true, rejectedAt: 1_699_000_000n }),
    latestEvidence: TOMBSTONE_HASH
  });
  assert.throws(
    () => assertFinalizeEligible(rejected, { janitor: JANITOR, tombstoneHash: TOMBSTONE_HASH }),
    /rejection event is missing/u
  );
  assert.throws(
    () => assertFinalizeEligible({ ...rejected, latestEvidence: WRONG_HASH, rescueRejection: {} }, {
      janitor: JANITOR,
      tombstoneHash: TOMBSTONE_HASH
    }),
    /does not carry the canonical/u
  );
});

test("refusal: finalization waits for the live dispute window", () => {
  const rejectedAt = 1_700_000_000n;
  assert.throws(
    () => assertFinalizeEligible(snapshot({
      job: job({ state: 4, worker: JANITOR, claimEconomicsWaived: true, rejectedAt }),
      latestEvidence: TOMBSTONE_HASH,
      chainTimestamp: Number(rejectedAt + 100n),
      rescueRejection: { transactionHash: PLAN_HASH }
    }), { janitor: JANITOR, tombstoneHash: TOMBSTONE_HASH, requireWindowElapsed: true }),
    /Dispute window is still active/u
  );
});

test("finalize dry-run reports an active dispute window without claiming callability", () => {
  const rejectedAt = 1_700_000_000n;
  const result = assertFinalizeEligible(snapshot({
    job: job({ state: 4, worker: JANITOR, claimEconomicsWaived: true, rejectedAt }),
    latestEvidence: TOMBSTONE_HASH,
    chainTimestamp: Number(rejectedAt + 100n),
    rescueRejection: { transactionHash: PLAN_HASH }
  }), {
    janitor: JANITOR,
    tombstoneHash: TOMBSTONE_HASH,
    requireWindowElapsed: false
  });
  assert.equal(result.windowElapsed, false);
  assert.equal(result.secondsRemaining, 604_701n);
});

test("finalization becomes eligible only after the live dispute window", () => {
  const rejectedAt = 1_699_000_000n;
  const result = assertFinalizeEligible(snapshot({
    job: job({ state: 4, worker: JANITOR, claimEconomicsWaived: true, rejectedAt }),
    latestEvidence: TOMBSTONE_HASH,
    rescueRejection: { transactionHash: PLAN_HASH }
  }), { janitor: JANITOR, tombstoneHash: TOMBSTONE_HASH });
  assert.deepEqual(result, {
    finalizeAfter: rejectedAt + 604_800n,
    windowElapsed: true,
    secondsRemaining: 0n
  });
});

test("refundable total is bound to the live job and contains no recipient input", () => {
  assert.equal(refundableTotal(job()), 1_100_000n);
  assert.equal(refundableTotal(job({ released: 100_000n, protocolFeeReleased: 10_000n })), 990_000n);
});

test("canonical tombstone hash is pinned to the published document bytes", async () => {
  const content = await readFile(TOMBSTONE_DOCUMENT_PATH, "utf8");
  assert.equal(
    hashTombstoneDocument(content),
    "0x0f76aab394ddcab4093fd767c26c5a693b2ac9a1cb53fc2927cec24de0811da9"
  );
});

test("plan hash binds chain, escrow, janitor, phase, and exact calldata", () => {
  const calls = buildCallPlan({
    phase: "finalize",
    jobId: JOB_ID,
    janitor: JANITOR,
    escrowAddress: ESCROW,
    tombstoneHash: TOMBSTONE_HASH,
    waiverEligible: true,
    state: 4
  });
  const base = buildPlanHash({
    chainId: 420420419,
    escrowAddress: ESCROW,
    phase: "finalize",
    jobId: JOB_ID,
    janitor: JANITOR,
    calls
  });
  assert.notEqual(base, buildPlanHash({
    chainId: 420420417,
    escrowAddress: ESCROW,
    phase: "finalize",
    jobId: JOB_ID,
    janitor: JANITOR,
    calls
  }));
});

test("dry-run prints the complete plan without reading a signing secret", async () => {
  let secretReads = 0;
  const lines = [];
  const result = await runRescue(args(), {
    loadManifest: async () => ({
      path: "/repo/deployments/mainnet.json",
      manifest: {
        profile: "mainnet",
        verifier: SIGNER,
        contracts: { escrowCore: ESCROW },
        deploymentBlocks: { escrowCoreV2: 18_809_168 }
      }
    }),
    loadTombstone: async () => ({
      file: TOMBSTONE_DOCUMENT_PATH,
      content: "sentinel",
      hash: TOMBSTONE_HASH
    }),
    createRpc: async () => ({
      chainId: 420420419,
      selectedUrl: "https://example.invalid/mainnet/",
      rpcUrls: ["https://example.invalid/mainnet/"],
      provider: { destroy: async () => {} }
    }),
    readSnapshot: async () => snapshot(),
    loadSecret: () => {
      secretReads += 1;
      throw new Error("must not read secret");
    },
    log: (line) => lines.push(String(line))
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(secretReads, 0);
  assert.equal(result.calls.length, 4);
  assert.match(lines.join("\n"), /future permissionless finalization/u);
  assert.match(lines.join("\n"), /plan hash:/u);
});

test("refusal: changed live plan aborts execute before secret access", async () => {
  let secretReads = 0;
  await assert.rejects(
    runRescue(args({
      execute: true,
      signerSecretRef: "op://vault/item/key",
      expectedPlanHash: WRONG_HASH,
      confirm: `RESCUE ${JOB_ID}`
    }), {
      loadManifest: async () => ({
        path: "/repo/deployments/mainnet.json",
        manifest: {
          profile: "mainnet",
          verifier: SIGNER,
          contracts: { escrowCore: ESCROW },
          deploymentBlocks: { escrowCoreV2: 18_809_168 }
        }
      }),
      loadTombstone: async () => ({
        file: TOMBSTONE_DOCUMENT_PATH,
        content: "sentinel",
        hash: TOMBSTONE_HASH
      }),
      createRpc: async () => ({
        chainId: 420420419,
        selectedUrl: "https://example.invalid/mainnet/",
        rpcUrls: ["https://example.invalid/mainnet/"],
        provider: { destroy: async () => {} },
        writeBroadcaster: { destroy: async () => {} }
      }),
      readSnapshot: async () => snapshot(),
      loadSecret: () => {
        secretReads += 1;
        throw new Error("must not read secret");
      },
      log: () => {}
    }),
    /does not match live plan/u
  );
  assert.equal(secretReads, 0);
});
