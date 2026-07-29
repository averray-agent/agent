import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCreateAddress, Interface } from "ethers";
import {
  parseArgs,
  loadKeyFromOp,
  planDeploy,
  resolveDeployPredictionDeployer,
  assertMainnetPhaseOneDeployerBalance,
  MAINNET_MIN_ESCROW_DEPLOYER_BALANCE_WEI,
  formatCeremonyBroadcastError,
  runCeremonyBroadcastSafely,
  verifyExpectedDeployerAndBroadcast,
  applyEscrowRedeployManifest,
  rewriteEscrowAddressInTemplate,
  collectOldEscrowJobIds,
  resolveOrphanScanFromBlock,
  evaluateOrphanedBalancePreflight,
  assertArtifactHasBrokeredSelectors,
  ESCROW_TAIL_SCAN_ABI
} from "./redeploy-escrowcore.mjs";

function abiWith(names) {
  return {
    abi: [
      {
        type: "constructor",
        inputs: [
          { name: "policy_", type: "address" },
          { name: "accounts_", type: "address" },
          { name: "reputation_", type: "address" },
          { name: "treasuryAccount_", type: "address" }
        ]
      },
      ...names.map((name) => ({ type: "function", name }))
    ]
  };
}

test("assertArtifactHasBrokeredSelectors passes for the complete v2 fee surface", () => {
  assert.doesNotThrow(() =>
    assertArtifactHasBrokeredSelectors(
      abiWith([
        "claimJobFor",
        "submitWorkFor",
        "openDisputeFor",
        "previewProtocolFee",
        "setProtocolFeeBps",
        "setTreasuryAccount",
        "createSinglePayoutJobFeeWaived"
      ])
    )
  );
});

test("assertArtifactHasBrokeredSelectors throws naming missing v2 selectors", () => {
  assert.throws(
    () => assertArtifactHasBrokeredSelectors(abiWith(["claimJobFor"])),
    /missing required EscrowCore-v2 selector\(s\): submitWorkFor, openDisputeFor/
  );
});

test("parseArgs defaults to dry-run + phase=all + profile=testnet", () => {
  const args = parseArgs([]);
  assert.equal(args.dryRun, true);
  assert.equal(args.phase, "all");
  assert.equal(args.profile, "testnet");
  assert.equal(args.signerSecretRef, undefined);
  assert.equal(args.orphanScanFromBlock, undefined);
});

test("parseArgs accepts --commit + --phase deploy", () => {
  const args = parseArgs(["--commit", "--phase", "deploy"]);
  assert.equal(args.dryRun, false);
  assert.equal(args.phase, "deploy");
});

test("parseArgs reads --signer-secret-ref including embedded spaces", () => {
  const args = parseArgs([
    "--phase", "deploy", "--commit",
    "--expected-deployer", "0x9Ab8531FBb0948C542a31298FD61335f30064239",
    "--signer-secret-ref", "op://prod-critical/admin-eoa-testnet/private key"
  ]);
  assert.equal(args.expectedDeployer, "0x9Ab8531FBb0948C542a31298FD61335f30064239");
  assert.equal(args.signerSecretRef, "op://prod-critical/admin-eoa-testnet/private key");
});

test("commit requires an explicit expected deployer instead of authorizing from manifest history", () => {
  assert.throws(
    () => resolveDeployPredictionDeployer({
      expectedDeployer: undefined,
      historicalDeployer: "0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1",
      commit: true
    }),
    /--expected-deployer is required for --commit/u
  );
});

test("mainnet Phase 1 balance preflight rejects 0.99 DOT with an explicit 2 DOT remedy", async () => {
  const deployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  await assert.rejects(
    assertMainnetPhaseOneDeployerBalance({
      provider: {
        async getBalance(address) {
          assert.equal(address, deployer);
          return 990_000_000_000_000_000n;
        }
      },
      deployer
    }),
    /Phase 1 deployer balance preflight failed: .* has 0\.99 DOT; requires at least 2\.0 DOT.*Substrate 1010 "Invalid Transaction"/u
  );
});

test("mainnet Phase 1 balance preflight accepts exactly 2 DOT", async () => {
  const deployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const result = await assertMainnetPhaseOneDeployerBalance({
    provider: {
      async getBalance() {
        return MAINNET_MIN_ESCROW_DEPLOYER_BALANCE_WEI;
      }
    },
    deployer
  });
  assert.equal(result.balanceWei, 2_000_000_000_000_000_000n);
  assert.equal(result.minimumWei, 2_000_000_000_000_000_000n);
});

test("ceremony broadcast maps Substrate 1010 without exposing the signed transaction", () => {
  const signedTransaction = "0x" + "ab".repeat(24_000);
  const formatted = formatCeremonyBroadcastError(
    Object.assign(new Error("could not coalesce error"), {
      code: "UNKNOWN_ERROR",
      info: {
        error: {
          code: 1010,
          message: "Invalid Transaction"
        },
        payload: {
          method: "eth_sendRawTransaction",
          params: [signedTransaction]
        }
      }
    })
  );

  assert.match(
    formatted,
    /Substrate pool error 1010: transaction invalid, most likely insufficient balance for fee\+deposit/u
  );
  assert.match(formatted, /at least 2\.0 DOT/u);
  assert.match(formatted, /Raw signed transaction and RPC payload suppressed/u);
  assert.ok(formatted.length < 1_000);
  assert.doesNotMatch(formatted, /abababababababab/u);
  assert.doesNotMatch(formatted, /eth_sendRawTransaction/u);
});

test("ceremony broadcast maps serialized Substrate 1012 to the pool cooldown remedy", () => {
  const signedTransaction = "0x" + "cd".repeat(24_000);
  const formatted = formatCeremonyBroadcastError({
    code: "UNKNOWN_ERROR",
    error: {
      body: JSON.stringify({
        error: {
          code: 1012,
          message: "Transaction is temporarily banned"
        },
        params: [signedTransaction]
      })
    }
  });

  assert.match(
    formatted,
    /Substrate pool error 1012: this exact transaction was recently rejected and is pool-banned for ~30 min; fix the cause and retry after the cooldown/u
  );
  assert.match(formatted, /Raw signed transaction and RPC payload suppressed/u);
  assert.ok(formatted.length < 1_000);
  assert.doesNotMatch(formatted, /cdcdcdcdcdcdcdcd/u);
});

test("unknown ceremony broadcast errors retain a short reason but suppress RPC payloads", () => {
  const signedTransaction = "0x" + "ef".repeat(24_000);
  const formatted = formatCeremonyBroadcastError({
    code: "UNKNOWN_ERROR",
    shortMessage: "upstream connection reset while broadcasting",
    payload: {
      method: "eth_sendRawTransaction",
      params: [signedTransaction]
    }
  });

  assert.match(formatted, /UNKNOWN_ERROR/u);
  assert.match(formatted, /upstream connection reset while broadcasting/u);
  assert.match(formatted, /Raw signed transaction and RPC payload suppressed/u);
  assert.ok(formatted.length < 1_000);
  assert.doesNotMatch(formatted, /efefefefefefefef/u);
  assert.doesNotMatch(formatted, /eth_sendRawTransaction/u);
});

test("ceremony broadcast boundary rethrows only the sanitized error", async () => {
  const signedTransaction = "0x" + "12".repeat(24_000);
  const rawError = Object.assign(new Error("could not coalesce error"), {
    code: "UNKNOWN_ERROR",
    info: {
      error: {
        code: 1012,
        message: "Transaction is temporarily banned"
      },
      payload: {
        method: "eth_sendRawTransaction",
        params: [signedTransaction]
      }
    }
  });

  await assert.rejects(
    runCeremonyBroadcastSafely(async () => {
      throw rawError;
    }),
    (error) => {
      assert.notEqual(error, rawError);
      assert.equal(error.cause, undefined);
      assert.match(error.message, /Substrate pool error 1012/u);
      assert.doesNotMatch(error.message, /1212121212121212/u);
      assert.doesNotMatch(error.stack, /1212121212121212/u);
      return true;
    }
  );
});

test("mismatched expected deployer aborts before broadcast", async () => {
  const expectedDeployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const derivedSigner = "0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1";
  const predictedAddress = getCreateAddress({ from: expectedDeployer, nonce: 7 });
  let broadcastCalls = 0;

  await assert.rejects(
    verifyExpectedDeployerAndBroadcast({
      expectedDeployer,
      derivedSigner,
      predictionDeployer: expectedDeployer,
      predictedAddress,
      async broadcast() {
        broadcastCalls += 1;
        return { newAddress: predictedAddress };
      }
    }),
    /derived signer .* does not match --expected-deployer/u
  );
  assert.equal(broadcastCalls, 0);
});

test("CREATE prediction sender must also match the explicit expected deployer", async () => {
  const expectedDeployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const historicalDeployer = "0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1";
  let broadcastCalls = 0;

  await assert.rejects(
    verifyExpectedDeployerAndBroadcast({
      expectedDeployer,
      derivedSigner: expectedDeployer,
      predictionDeployer: historicalDeployer,
      predictedAddress: getCreateAddress({ from: historicalDeployer, nonce: 33 }),
      async broadcast() {
        broadcastCalls += 1;
        return { newAddress: "0x0000000000000000000000000000000000000001" };
      }
    }),
    /CREATE prediction used .* not --expected-deployer .* refusing to broadcast/u
  );
  assert.equal(broadcastCalls, 0);
});

test("matching expected deployer drives CREATE prediction and deployed-address verification", async () => {
  const expectedDeployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const nonce = 7;
  const manifest = {
    contracts: {
      treasuryPolicy: "0x226F14252A98BD2eA140271647De20132F09AF20",
      agentAccountCore: "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57",
      reputationSbt: "0xA85AF867b5f573176f49F0D6A827F61A5Cee4e37"
    },
    treasuryAccount: "0x01e6eed856e989201f4ff6346e18eab7e46c874c"
  };
  const artifact = {
    ...abiWith([]),
    bytecode: "0x60006000f3"
  };
  const nonceReads = [];
  const plan = await planDeploy({
    provider: {
      async getTransactionCount(address, blockTag) {
        nonceReads.push({ address, blockTag });
        return nonce;
      }
    },
    manifest,
    artifact,
    deployer: expectedDeployer
  });
  const expectedAddress = getCreateAddress({ from: expectedDeployer, nonce });
  assert.equal(plan.predicted, expectedAddress);
  assert.deepEqual(nonceReads, [{ address: expectedDeployer, blockTag: "pending" }]);

  let broadcastCalls = 0;
  const result = await verifyExpectedDeployerAndBroadcast({
    expectedDeployer,
    derivedSigner: expectedDeployer,
    predictionDeployer: plan.deployer,
    predictedAddress: plan.predicted,
    async broadcast() {
      broadcastCalls += 1;
      return { newAddress: expectedAddress };
    }
  });
  assert.equal(broadcastCalls, 1);
  assert.equal(result.newAddress, expectedAddress);
});

test("v2 finalize metadata preserves historical v1 deployer and block", () => {
  const v1Deployer = "0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1";
  const v2Deployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const manifest = {
    deployer: v1Deployer,
    contracts: {
      escrowCore: "0x9cCd1DbBB5C354CC6218e55D3cE924A4d631C035"
    },
    deploymentBlocks: {
      escrowCore: 18_647_902
    }
  };
  applyEscrowRedeployManifest({
    manifest,
    oldEscrow: manifest.contracts.escrowCore,
    newEscrow: "0xAcC2CAc2E814F243dbFEAE1B99BcfE1A1A7846Ed",
    deployer: v2Deployer,
    deployBlock: 18_806_500,
    deployTx: "0x" + "11".repeat(32),
    multisigExecTx: "0x" + "22".repeat(32),
    skipRevoke: true,
    redeployedAt: "2026-07-29T12:00:00.000Z"
  });

  assert.equal(manifest.deployer, v1Deployer);
  assert.equal(manifest.deployers.escrowCoreV2, v2Deployer);
  assert.equal(manifest.deploymentBlocks.escrowCore, 18_647_902);
  assert.equal(manifest.deploymentBlocks.escrowCoreV2, 18_806_500);
});

test("parseArgs collects finalize-phase tx hashes", () => {
  const args = parseArgs([
    "--phase", "finalize",
    "--new-escrow", "0x0000000000000000000000000000000000000001",
    "--deploy-tx", "0x" + "11".repeat(32),
    "--multisig-exec-tx", "0x" + "22".repeat(32),
    "--commit",
    "--skip-revoke"
  ]);
  assert.equal(args.phase, "finalize");
  assert.equal(args.dryRun, false);
  assert.equal(args.newEscrow, "0x0000000000000000000000000000000000000001");
  assert.equal(args.deployTx, "0x" + "11".repeat(32));
  assert.equal(args.multisigExecTx, "0x" + "22".repeat(32));
  assert.equal(args.skipRevoke, true);
});

test("parseArgs collects --skip-* flags", () => {
  const args = parseArgs([
    "--phase", "finalize",
    "--skip-manifest-update",
    "--skip-audit-rerun"
  ]);
  assert.equal(args.skipManifestUpdate, true);
  assert.equal(args.skipAuditRerun, true);
});

test("parseArgs collects orphaned balance acknowledgement flags", () => {
  const args = parseArgs([
    "--phase", "deploy",
    "--acknowledge-orphaned-balances",
    "--from-block", "8800000",
    "--orphan-scan-chunk-size", "5000"
  ]);
  assert.equal(args.acknowledgeOrphanedBalances, true);
  assert.equal(args.orphanScanFromBlock, 8_800_000);
  assert.equal(args.orphanScanChunkSize, 5_000);
});

test("orphan scan defaults to the manifest deployment block and accepts an explicit override", () => {
  const manifest = {
    deploymentBlocks: {
      escrowCore: 18_647_902
    }
  };
  assert.deepEqual(
    resolveOrphanScanFromBlock({ manifest }),
    {
      fromBlock: 18_647_902,
      source: "deploymentBlocks.escrowCore"
    }
  );
  assert.deepEqual(
    resolveOrphanScanFromBlock({ manifest, fromBlock: 18_700_000 }),
    {
      fromBlock: 18_700_000,
      source: "--from-block"
    }
  );
  assert.deepEqual(
    resolveOrphanScanFromBlock({
      manifest: {
        deploymentBlocks: {
          escrowCore: 18_647_902,
          escrowCoreV2: 18_806_500
        }
      }
    }),
    {
      fromBlock: 18_806_500,
      source: "deploymentBlocks.escrowCoreV2"
    }
  );
});

test("orphan scan refuses a genesis fallback when the deployment block is missing", () => {
  assert.throws(
    () => resolveOrphanScanFromBlock({ manifest: { deploymentBlocks: {} } }),
    /Missing deployments manifest deploymentBlocks\.escrowCore.*pass --from-block explicitly.*refusing to scan from genesis/u
  );
});

test("collectOldEscrowJobIds reports progress and anchors timeout failures to blocks", async () => {
  const progress = [];
  const timeout = Object.assign(
    new Error('request timed out (operation="request.send")'),
    { code: "TIMEOUT" }
  );
  const provider = {
    async getBlockNumber() {
      return 160;
    },
    async getLogs({ fromBlock }) {
      if (fromBlock === 120) throw timeout;
      return [];
    }
  };

  await assert.rejects(
    collectOldEscrowJobIds({
      provider,
      escrowAddress: "0x9cCd1DbB0000000000000000000000000000C035",
      fromBlock: 100,
      toBlock: 160,
      chunkSize: 20,
      onProgress(entry) {
        progress.push(entry);
      }
    }),
    /Escrow orphan scan timed out at block 120 of 160.*chunk 2\/4.*blocks 120-139/u
  );

  assert.deepEqual(
    progress.map(({ chunkIndex, totalChunks, fromBlock, toBlock }) => ({
      chunkIndex,
      totalChunks,
      fromBlock,
      toBlock
    })),
    [
      { chunkIndex: 1, totalChunks: 4, fromBlock: 100, toBlock: 119 },
      { chunkIndex: 2, totalChunks: 4, fromBlock: 120, toBlock: 139 }
    ]
  );
});

test("loadKeyFromOp rejects refs that aren't op://", () => {
  assert.throws(
    () => loadKeyFromOp("/Users/me/.paseo.env"),
    /must be an 'op:\/\/...' reference/u
  );
  assert.throws(
    () => loadKeyFromOp(""),
    /must be an 'op:\/\/...' reference/u
  );
  assert.throws(
    () => loadKeyFromOp(undefined),
    /must be an 'op:\/\/...' reference/u
  );
});

test("setSettlementBroker(address,bool) selector encoding is stable", () => {
  const iface = new Interface(["function setSettlementBroker(address account, bool allowed)"]);
  const data = iface.encodeFunctionData("setSettlementBroker", [
    "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27",
    true
  ]);
  assert.equal(
    data,
    "0xd77baf73000000000000000000000000b8fd8a932f69bd5e39700b7cf6d2920af84d1b270000000000000000000000000000000000000000000000000000000000000001"
  );
});

test("rewriteEscrowAddressInTemplate updates the ESCROW_CORE_ADDRESS line in place", () => {
  const before = [
    "TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B",
    "AGENT_ACCOUNT_ADDRESS=0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    "ESCROW_CORE_ADDRESS=0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a",
    "REPUTATION_SBT_ADDRESS=0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"
  ].join("\n") + "\n";
  const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
  const result = rewriteEscrowAddressInTemplate(before, NEW);
  assert.equal(result.changed, true);
  assert.equal(result.previousValue, "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a");
  assert.ok(result.text.includes(`ESCROW_CORE_ADDRESS=${NEW}`));
  // Other lines must be untouched.
  assert.ok(result.text.includes("TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B"));
  assert.ok(result.text.includes("REPUTATION_SBT_ADDRESS=0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"));
});

test("rewriteEscrowAddressInTemplate is a no-op when value already matches", () => {
  const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
  const text = `ESCROW_CORE_ADDRESS=${NEW}\n`;
  const result = rewriteEscrowAddressInTemplate(text, NEW);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "already up to date");
});

test("rewriteEscrowAddressInTemplate reports missing ESCROW_CORE_ADDRESS line", () => {
  const result = rewriteEscrowAddressInTemplate("FOO=bar\n", "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "no ESCROW_CORE_ADDRESS line");
});

function syntheticPreflightReport(findings) {
  return {
    oldEscrow: "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a",
    agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    scan: {
      fromBlock: 8_800_000,
      toBlock: 9_300_000,
      chunkSize: 25_000,
      scannedLogCount: 58,
      unmatchedLogCount: 0,
      unmatchedTopics: [],
      scannedJobCount: 9
    },
    findings
  };
}

function syntheticFinding(overrides = {}) {
  const emptyPosition = {
    liquid: "0",
    reserved: "0",
    strategyAllocated: "0",
    collateralLocked: "0",
    jobStakeLocked: "0",
    debtOutstanding: "0",
    formatted: {
      liquid: "0.0",
      reserved: "0.0",
      jobStakeLocked: "0.0",
      debtOutstanding: "0.0"
    }
  };
  return {
    jobId: "0x" + "42".repeat(32),
    poster: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    worker: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    asset: "0x0000053900000000000000000000000001200000",
    reward: "100000",
    opsReserve: "0",
    contingencyReserve: "0",
    released: "0",
    claimExpiry: "1778878728",
    claimStake: "10000",
    claimFee: "50000",
    rejectedAt: "0",
    disputedAt: "0",
    payoutMode: "Single",
    state: "Submitted",
    stateIndex: 3,
    posterPosition: {
      ...emptyPosition,
      reserved: "200001",
      jobStakeLocked: "60000",
      formatted: {
        ...emptyPosition.formatted,
        reserved: "0.200001",
        jobStakeLocked: "0.06"
      }
    },
    workerPosition: emptyPosition,
    nonZeroTails: {
      poster: true,
      worker: false
    },
    ...overrides
  };
}

test("evaluateOrphanedBalancePreflight passes clean synthetic escrow state", () => {
  const decision = evaluateOrphanedBalancePreflight(syntheticPreflightReport([]));
  assert.equal(decision.ok, true);
  assert.equal(decision.acknowledged, false);
  assert.match(decision.message, /No unsettled old EscrowCore jobs/u);
  assert.match(decision.message, /covered all 58 old EscrowCore event log/u);
});

test("collectOldEscrowJobIds skips and counts an unknown topic instead of crashing", async () => {
  const unknownTopic0 = "0x" + "ab".repeat(32);
  const provider = {
    async getBlockNumber() {
      return 12;
    },
    async getLogs() {
      return [{
        address: "0x9cCd1DbB0000000000000000000000000000C035",
        blockNumber: 10,
        data: "0x",
        topics: [unknownTopic0],
        transactionHash: "0x" + "11".repeat(32),
        transactionIndex: 0,
        blockHash: "0x" + "22".repeat(32),
        logIndex: 0,
        removed: false
      }];
    }
  };

  const result = await collectOldEscrowJobIds({
    provider,
    escrowAddress: "0x9cCd1DbB0000000000000000000000000000C035",
    fromBlock: 10,
    toBlock: 12,
    chunkSize: 10
  });

  assert.equal(result.scannedLogCount, 1);
  assert.equal(result.unmatchedLogCount, 1);
  assert.deepEqual(result.unmatchedTopics, [{ topic0: unknownTopic0, count: 1 }]);
  assert.deepEqual(result.jobIds, []);

  const decision = evaluateOrphanedBalancePreflight({
    ...syntheticPreflightReport([]),
    scan: {
      ...syntheticPreflightReport([]).scan,
      scannedLogCount: 1,
      unmatchedLogCount: 1,
      unmatchedTopics: result.unmatchedTopics
    }
  });
  assert.equal(decision.unmatchedLogCount, 1);
  assert.match(decision.message, /WARNING: 1 old EscrowCore event log\(s\) are not covered/u);
  assert.match(decision.message, new RegExp(unknownTopic0, "u"));
});

test("tail-scan ABI covers every event declared by the current EscrowCore source", () => {
  const escrowSource = readFileSync(
    new URL("../../contracts/EscrowCore.sol", import.meta.url),
    "utf8"
  );
  const sourceEventNames = [
    ...escrowSource.matchAll(/\bevent\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu)
  ].map((match) => match[1]);
  const scanInterface = new Interface(ESCROW_TAIL_SCAN_ABI);
  const eventNames = new Set(
    scanInterface.fragments
      .filter((fragment) => fragment.type === "event")
      .map((fragment) => fragment.name)
  );
  assert.deepEqual(
    [...eventNames].sort(),
    [...new Set(sourceEventNames)].sort()
  );
  assert.equal(
    scanInterface.getEvent("OnboardingWaiverEligibilityUpdated").topicHash,
    "0x315d0d53327cca8ef25cfa00536a09a8608f7c6419c757c15e40d87df8613649",
    "the previously unmatched live topic must now decode"
  );
});

test("evaluateOrphanedBalancePreflight aborts on synthetic stuck balances", () => {
  assert.throws(
    () => evaluateOrphanedBalancePreflight(syntheticPreflightReport([syntheticFinding()])),
    /Abort: settle or finalize these jobs first/u
  );
});

test("evaluateOrphanedBalancePreflight bypasses stuck balances with explicit acknowledgement", () => {
  const decision = evaluateOrphanedBalancePreflight(
    syntheticPreflightReport([syntheticFinding()]),
    { acknowledge: true }
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.acknowledged, true);
  assert.match(decision.message, /Acknowledged via --acknowledge-orphaned-balances/u);
  assert.match(decision.message, /state=Submitted claimExpiry=1778878728/u);
});
