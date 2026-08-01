import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../../mcp-server/src/core/external-posting-service.js";
import { hashCanonicalContent } from "../../mcp-server/src/core/canonical-content.js";
import { MemoryStateStore } from "../../mcp-server/src/core/state-store.js";
import {
  CREATE_SINGLE_PAYOUT_SIGNATURE,
  assertDefinitionMatchesDraft,
  buildFundingMath,
  findMatchingExternalCatalogJob,
  parseArgs,
  runPosterBounty,
  validateAndEncodeDraftCalldata,
  validateArgs
} from "./post-external-bounty.mjs";

const POSTER = "0x089a0A57D001bACb8473161e007F0bAbC1768CeE";
const ESCROW = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
const TOKEN = "0x0000053900000000000000000000000001200000";
const AAC = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const JOB_ID = `0x${"11".repeat(32)}`;
const DRAFT_ID = `0x${"22".repeat(32)}`;
const SPEC_HASH = `0x${"33".repeat(32)}`;
const MANIFEST = {
  profile: "mainnet",
  contracts: {
    escrowCore: ESCROW,
    token: TOKEN,
    agentAccountCore: AAC
  }
};
const REWARD_DEFINITION = { rewardAmount: "1" };

function makeDraft(overrides = {}) {
  return {
    draftId: DRAFT_ID,
    jobId: JOB_ID,
    specHash: SPEC_HASH,
    status: "awaiting_funding",
    calldata: {
      to: ESCROW,
      function: CREATE_SINGLE_PAYOUT_SIGNATURE,
      args: [
        JOB_ID,
        TOKEN,
        "1000000",
        "0",
        "0",
        "86400",
        `0x${"44".repeat(32)}`,
        `0x${"55".repeat(32)}`,
        SPEC_HASH
      ],
      value: "0"
    },
    ...overrides
  };
}

function makeDraftForDefinition(definition) {
  const specHash = hashCanonicalContent(definition);
  const draft = makeDraft();
  return makeDraft({
    definition,
    specHash,
    calldata: {
      ...draft.calldata,
      args: [...draft.calldata.args.slice(0, 8), specHash]
    }
  });
}

function inlineArgs(extra = {}) {
  return {
    profile: "mainnet",
    apiBaseUrl: "https://api.averray.com",
    definitionFile: undefined,
    draftId: undefined,
    signerSecretRef: "op://mainnet-poster/private-key/credential",
    expectedPoster: POSTER,
    execute: false,
    task: "Audit and report on a repository issue.",
    repo: "owner/repo",
    rewardUsdc: "1",
    verifierMode: "human_fallback",
    acceptanceCriteria: ["Return an implementation report."],
    watchTimeoutMs: 1000,
    watchIntervalMs: 10,
    help: false,
    ...extra
  };
}

test("CLI is dry-run by default and requires an explicit profile", () => {
  const parsed = parseArgs([
    "--profile", "mainnet",
    "--definition-file", "job.json",
    "--expected-poster", POSTER,
    "--signer-secret-ref", "op://vault/item/field"
  ]);
  assert.equal(parsed.execute, false);
  assert.equal(parsed.profile, "mainnet");

  const missingProfile = { ...parsed, profile: undefined };
  assert.throws(
    () => validateArgs(missingProfile),
    /--profile is required; refusing to default/u
  );
  assert.equal(parseArgs(["--execute"]).execute, true);
  assert.throws(
    () => validateArgs({ ...inlineArgs(), execute: true }),
    /--execute requires --draft-id from a reviewed dry-run/u
  );
});

test("500 bps funding math is poster-side additive: 1.05 / 1.00 / 0.05", () => {
  const math = buildFundingMath({
    rewardRaw: "1000000",
    opsReserveRaw: "0",
    contingencyReserveRaw: "0",
    protocolFeeBps: "500",
    previewProtocolFeeRaw: "50000"
  });
  assert.equal(math.posterReservedRaw, 1_050_000n);
  assert.equal(math.workerOwedRaw, 1_000_000n);
  assert.equal(math.protocolFeeRaw, 50_000n);
});

test("funding math fails closed when the live fee or preview differs", () => {
  assert.throws(
    () => buildFundingMath({
      rewardRaw: "1000000",
      opsReserveRaw: "0",
      contingencyReserveRaw: "0",
      protocolFeeBps: "0",
      previewProtocolFeeRaw: "0"
    }),
    /expected 500/u
  );
  assert.throws(
    () => buildFundingMath({
      rewardRaw: "1000000",
      opsReserveRaw: "0",
      contingencyReserveRaw: "0",
      protocolFeeBps: "500",
      previewProtocolFeeRaw: "49999"
    }),
    /Refusing to fund unreconciled fee math/u
  );
});

test("draft calldata validates against manifest v2, committed reward, and the non-waived call", () => {
  const result = validateAndEncodeDraftCalldata({
    draft: makeDraft(),
    manifest: MANIFEST,
    definition: REWARD_DEFINITION
  });
  assert.equal(result.to, ESCROW);
  assert.equal(result.token, TOKEN);
  assert.equal(result.decoded.jobId, JOB_ID);
  assert.equal(result.decoded.rewardRaw, 1_000_000n);
  assert.equal(result.decoded.opsReserveRaw, 0n);
  assert.equal(result.decoded.contingencyReserveRaw, 0n);
  assert.equal(result.decoded.claimTtlSeconds, 86_400n);
  assert.equal(result.decoded.specHash, SPEC_HASH);
  assert.match(result.encoded, /^0x[0-9a-f]+$/u);
});

test("fee-waived or wrong-contract draft calldata is refused", () => {
  assert.throws(
    () => validateAndEncodeDraftCalldata({
      draft: makeDraft({
        calldata: {
          ...makeDraft().calldata,
          function: "createSinglePayoutJobFeeWaived(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)"
        }
      }),
      manifest: MANIFEST,
      definition: REWARD_DEFINITION
    }),
    /expected the non-waived/u
  );
  assert.throws(
    () => validateAndEncodeDraftCalldata({
      draft: makeDraft({ calldata: { ...makeDraft().calldata, to: AAC } }),
      manifest: MANIFEST,
      definition: REWARD_DEFINITION
    }),
    /manifest EscrowCore/u
  );
});

test("draft calldata reward must equal the committed definition rewardAmount", () => {
  const draft = makeDraft({
    calldata: {
      ...makeDraft().calldata,
      args: [
        ...makeDraft().calldata.args.slice(0, 2),
        "999999",
        ...makeDraft().calldata.args.slice(3)
      ]
    }
  });

  assert.throws(
    () => validateAndEncodeDraftCalldata({
      draft,
      manifest: MANIFEST,
      definition: REWARD_DEFINITION
    }),
    /committed definition\.rewardAmount "1" requires 1000000.*Refusing reward drift/u
  );
});

test("catalog match requires the external source and exact poster", () => {
  const expected = {
    id: JOB_ID,
    source: "external",
    poster: { wallet: POSTER.toLowerCase() }
  };
  assert.equal(
    findMatchingExternalCatalogJob({ jobs: [expected] }, { jobId: JOB_ID, poster: POSTER }),
    expected
  );
  assert.equal(
    findMatchingExternalCatalogJob(
      { jobs: [{ ...expected, source: "github_issue" }] },
      { jobId: JOB_ID, poster: POSTER }
    ),
    undefined
  );
});

test("committed dogfood definition is accepted by the live external-draft validator", async () => {
  const definition = JSON.parse(await readFile(
    new URL("./external-bounties/lingdojo-kana-dojo-26665.json", import.meta.url),
    "utf8"
  ));
  const config = resolveExternalPostingConfig({
    EXTERNAL_POSTING_MODE: "allowlist",
    EXTERNAL_POSTING_ALLOWLIST: POSTER,
    EXTERNAL_POSTING_MIN_REWARD_USDC: "1",
    EXTERNAL_POSTING_DRAFT_TTL_HOURS: "72",
    ESCROW_CORE_ADDRESS: ESCROW,
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      { symbol: "USDC", address: TOKEN, decimals: 6 }
    ])
  });
  const service = new ExternalPostingService({
    stateStore: new MemoryStateStore(),
    config,
    now: () => new Date("2026-07-31T10:00:00.000Z")
  });

  const draft = await service.createDraft(POSTER, { definition });
  assert.equal(draft.status, "awaiting_funding");
  assert.equal(draft.definition.verifierMode, "human_fallback");
  assert.equal(draft.definition.rewardAmount, "1");
  assert.equal(draft.calldata.function, CREATE_SINGLE_PAYOUT_SIGNATURE);
  assert.equal(draft.calldata.args[2], "1000000");
  assert.equal(draft.calldata.args[3], "0");
  assert.equal(draft.calldata.args[4], "0");
  assert.equal(assertDefinitionMatchesDraft(definition, draft), draft.specHash);
});

test("default dry-run performs SIWE and draft creation but never enters write execution", async () => {
  const calls = [];
  const plan = {
    fundingMath: {
      protocolFeeBps: 500n,
      workerOwedRaw: 1_000_000n,
      protocolFeeRaw: 50_000n,
      opsReserveRaw: 0n,
      contingencyReserveRaw: 0n,
      posterReservedRaw: 1_050_000n
    },
    treasuryAccount: "0x01e6eed856e989201f4ff6346e18eab7e46c874c",
    liquidRaw: 0n,
    depositRequiredRaw: 1_050_000n,
    walletUsdcRaw: 2_100_000n,
    calldata: {
      to: ESCROW,
      encoded: "0x1234",
      decoded: {
        jobId: JOB_ID,
        asset: TOKEN,
        rewardRaw: 1_000_000n,
        opsReserveRaw: 0n,
        contingencyReserveRaw: 0n,
        claimTtlSeconds: 86_400n,
        verifierModeHash: `0x${"44".repeat(32)}`,
        categoryHash: `0x${"55".repeat(32)}`,
        specHash: SPEC_HASH
      }
    }
  };
  let executeCalls = 0;
  let watchCalls = 0;
  let destroyed = false;
  const result = await runPosterBounty(inlineArgs(), {
    loadManifest: async () => ({ path: "/repo/deployments/mainnet.json", manifest: MANIFEST }),
    createRpc: async () => ({
      provider: { destroy: async () => { destroyed = true; } },
      chainId: 420420419,
      selectedUrl: "https://rpc.example/mainnet/",
      rpcUrls: ["https://rpc.example/mainnet/"]
    }),
    loadSecret: () => "concealed-key",
    makeWallet: () => ({ address: POSTER }),
    login: async () => {
      calls.push("siwe");
      return { token: "concealed-token", expiresAt: "2026-08-01T00:00:00Z" };
    },
    postDraft: async ({ definition }) => {
      calls.push("draft");
      return makeDraftForDefinition(definition);
    },
    inspect: async () => {
      calls.push("inspect");
      return plan;
    },
    execute: async () => { executeCalls += 1; },
    watch: async () => { watchCalls += 1; },
    log: () => {}
  });

  assert.deepEqual(calls, ["siwe", "draft", "inspect"]);
  assert.equal(result.mode, "dry-run");
  assert.equal(executeCalls, 0);
  assert.equal(watchCalls, 0);
  assert.equal(destroyed, true);
});

test("execute reloads the reviewed draft id and never creates a second draft", async () => {
  const calls = [];
  const definition = {
    title: "Audit and report on owner/repo",
    description: "Audit and report on a repository issue.",
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: "1",
    verifierMode: "human_fallback",
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: "Audit and report on a repository issue.",
      acceptanceCriteria: ["Return an implementation report."],
      repo: "owner/repo"
    },
    acceptanceCriteria: ["Return an implementation report."],
    claimTtlSeconds: 86_400,
    retryLimit: 1,
    requiresSponsoredGas: true
  };
  const draft = makeDraftForDefinition(definition);
  const plan = {
    fundingMath: {
      protocolFeeBps: 500n,
      workerOwedRaw: 1_000_000n,
      protocolFeeRaw: 50_000n,
      opsReserveRaw: 0n,
      contingencyReserveRaw: 0n,
      posterReservedRaw: 1_050_000n
    },
    treasuryAccount: "0x01e6eed856e989201f4ff6346e18eab7e46c874c",
    liquidRaw: 0n,
    depositRequiredRaw: 1_050_000n,
    walletUsdcRaw: 2_100_000n,
    calldata: {
      to: ESCROW,
      encoded: "0x1234",
      decoded: {
        jobId: JOB_ID,
        asset: TOKEN,
        rewardRaw: 1_000_000n,
        opsReserveRaw: 0n,
        contingencyReserveRaw: 0n,
        claimTtlSeconds: 86_400n,
        verifierModeHash: `0x${"44".repeat(32)}`,
        categoryHash: `0x${"55".repeat(32)}`,
        specHash: draft.specHash
      }
    }
  };
  const args = inlineArgs({ execute: true, draftId: DRAFT_ID });
  const result = await runPosterBounty(args, {
    loadManifest: async () => ({ path: "/repo/deployments/mainnet.json", manifest: MANIFEST }),
    createRpc: async () => ({
      provider: { destroy: async () => {} },
      writeBroadcaster: { destroy: async () => {} },
      chainId: 420420419,
      selectedUrl: "https://rpc.example/mainnet/",
      rpcUrls: ["https://rpc.example/mainnet/"]
    }),
    loadSecret: () => "concealed-key",
    makeWallet: () => ({ address: POSTER }),
    login: async () => ({ token: "concealed-token" }),
    postDraft: async () => {
      calls.push("post-draft");
      throw new Error("must not create a second draft");
    },
    readDraft: async ({ draftId }) => {
      calls.push(`read:${draftId}`);
      return draft;
    },
    inspect: async () => plan,
    execute: async () => {
      calls.push("execute-reviewed");
      return { txs: { createJob: `0x${"66".repeat(32)}` }, blockNumber: 123 };
    },
    watch: async () => ({
      draft: { status: "live", txHash: `0x${"66".repeat(32)}` },
      job: { source: "external", poster: { wallet: POSTER.toLowerCase() } },
      elapsedMs: 100,
      attempts: 1
    }),
    log: () => {}
  });

  assert.equal(result.mode, "execute");
  assert.deepEqual(calls, [`read:${DRAFT_ID}`, "execute-reviewed"]);
});
