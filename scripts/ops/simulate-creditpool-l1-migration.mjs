#!/usr/bin/env node
/**
 * Fork-only rehearsal for the DepositPool v1 -> v2 + CreditPool L1 migration.
 *
 * Dry-run is the default and performs no writes. `--fork-execute` is accepted
 * only on a local Anvil chain (31337/1337) and uses account impersonation; it
 * can never target mainnet. Polkadot Hub's USDC is a runtime precompile that
 * Anvil cannot execute from forked state. After pinning the live position from
 * the source RPC, the script installs the same six-decimal mintable test shim
 * used by the original pool rehearsal and recreates only the pool's observed
 * buffer. This shim path is unreachable on a non-local chain id.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";

export const MIGRATION_STRATEGY_LABEL = "HYDRATION_USDC_POOL_V1";
export const LIVE_DOGFOOD_DEPOSITOR = "0xdc1Ed1061e4a6E35aafb8f4E59B8893113d2EDeC";
const CONTRACTS = {
  lane: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  venueAdapter: ["HydrationDepositPoolAdapter.sol", "HydrationDepositPoolAdapter"],
  depositPoolV2: ["DepositPoolV2.sol", "DepositPoolV2"],
  creditPool: ["CreditPool.sol", "CreditPool"]
};
const FORK_USDC_SHIM = ["DepositPool.t.sol", "MockPoolUsdc"];

export function predictCreditPoolMigrationAddresses(deployer, startNonce) {
  const address = ethers.getAddress(deployer);
  const nonce = Number(startNonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("startNonce must be a non-negative safe integer");
  return {
    lane: ethers.getCreateAddress({ from: address, nonce }),
    venueAdapter: ethers.getCreateAddress({ from: address, nonce: nonce + 1 }),
    depositPoolV2: ethers.getCreateAddress({ from: address, nonce: nonce + 2 }),
    creditPool: ethers.getCreateAddress({ from: address, nonce: nonce + 3 })
  };
}

export function assertByteExactMigration({ before, after }) {
  for (const field of ["sharesRaw", "assetsRaw", "principalRaw"]) {
    if (BigInt(before[field]) !== BigInt(after[field])) {
      throw new Error(`migration ${field} drift: before=${before[field]} after=${after[field]}`);
    }
  }
  const beforeTranches = JSON.stringify(before.tranches ?? []);
  const afterTranches = JSON.stringify(after.tranches ?? []);
  if (beforeTranches !== afterTranches) throw new Error("migration vesting tranches or ages drifted");
  return true;
}

export function buildVestingMigrationRecord({
  fromPool,
  toPool,
  wallet,
  oldWithdrawTx,
  newDepositTx,
  tranches
}) {
  return {
    schemaVersion: 1,
    fromPool: ethers.getAddress(fromPool),
    toPool: ethers.getAddress(toPool),
    wallet: ethers.getAddress(wallet),
    ignoredTransferEvents: {
      oldWithdrawTx: normalizeHash(oldWithdrawTx, "oldWithdrawTx"),
      newDepositTx: normalizeHash(newDepositTx, "newDepositTx")
    },
    preservedTranches: (tranches ?? []).map((entry) => ({
      depositedRaw: BigInt(entry.depositedRaw).toString(),
      remainingRaw: BigInt(entry.remainingRaw).toString(),
      depositedAt: new Date(entry.depositedAt).toISOString(),
      blockNumber: Number(entry.blockNumber),
      logIndex: Number(entry.logIndex),
      ...(entry.txHash ? { txHash: normalizeHash(entry.txHash, "tranche.txHash") } : {})
    }))
  };
}

export function buildDeploymentPlan({ manifest, deployer, startNonce, artifactsDir = "out" }) {
  const predicted = predictCreditPoolMigrationAddresses(deployer, startNonce);
  const asset = ethers.getAddress(manifest.contracts.token);
  const policy = ethers.getAddress(manifest.contracts.treasuryPolicy);
  const wrapper = ethers.getAddress(manifest.contracts.xcmWrapper);
  const operator = ethers.getAddress(manifest.verifier);
  const strategyId = ethers.encodeBytes32String(MIGRATION_STRATEGY_LABEL);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const artifact = Object.fromEntries(Object.entries(CONTRACTS).map(([key, value]) => [key, loadArtifact(artifactsDir, value)]));
  return {
    predicted,
    strategyId,
    transactions: [
      creation("lane", artifact.lane, coder.encode(
        ["address", "address", "bytes32", "address", "address"],
        [policy, asset, strategyId, wrapper, predicted.venueAdapter]
      )),
      creation("venueAdapter", artifact.venueAdapter, coder.encode(
        ["address", "address"],
        [predicted.depositPoolV2, predicted.lane]
      )),
      creation("depositPoolV2", artifact.depositPoolV2, coder.encode(
        ["address", "address", "address", "address"],
        [asset, operator, predicted.venueAdapter, predicted.creditPool]
      )),
      creation("creditPool", artifact.creditPool, coder.encode(
        ["address", "address", "address"],
        [asset, operator, predicted.depositPoolV2]
      ))
    ],
    wrapperConfiguration: {
      wrapper,
      strategyId,
      adapter: predicted.lane,
      calls: new ethers.Interface([
        "function setDispatchPaused(bool)",
        "function setStrategyAdapter(bytes32,address)"
      ])
    }
  };
}

function creation(step, artifact, encodedArgs) {
  return {
    step,
    creationHash: ethers.keccak256(artifact.bytecode),
    data: artifact.bytecode + encodedArgs.slice(2),
    abi: artifact.abi
  };
}

function loadArtifact(dir, [source, name]) {
  const path = join(dir, source, `${name}.json`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value?.bytecode?.object?.startsWith("0x")) throw new Error(`missing creation bytecode in ${path}`);
  return { bytecode: value.bytecode.object, abi: value.abi };
}

function normalizeHash(value, label) {
  const text = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(text)) throw new Error(`${label} must be a transaction hash`);
  return text;
}

function parseArgs(argv) {
  const output = { profile: "mainnet", artifacts: "out", forkExecute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile") output.profile = argv[++index];
    else if (value === "--rpc") output.rpc = argv[++index];
    else if (value === "--source-rpc") output.sourceRpc = argv[++index];
    else if (value === "--artifacts") output.artifacts = argv[++index];
    else if (value === "--deployer") output.deployer = argv[++index];
    else if (value === "--wallet") output.wallet = argv[++index];
    else if (value === "--fork-execute") output.forkExecute = true;
  }
  return output;
}

async function impersonate(provider, address) {
  await provider.send("anvil_impersonateAccount", [address]);
  await provider.send("anvil_setBalance", [address, "0x3635c9adc5dea00000"]);
  return provider.getSigner(address);
}

async function readLiveMigrationSnapshot({ provider, manifest, wallet, sourceBlockNumber }) {
  const poolAddress = ethers.getAddress(manifest.contracts.depositPool);
  const depositor = ethers.getAddress(wallet);
  const pool = new ethers.Contract(poolAddress, [
    "event Deposit(address indexed caller,address indexed owner,uint256 assets,uint256 shares)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function assetsOf(address) view returns (uint256)",
    "function bufferAssets() view returns (uint256)",
    "function venuePrincipalCostBasis() view returns (uint256)",
    "function activeVenueDeploymentId() view returns (uint256)",
    "function activeVenueRecallId() view returns (uint256)"
  ], provider);
  const fromBlock = Number(manifest.deploymentBlocks?.depositPool ?? 0);
  if (!Number.isSafeInteger(fromBlock) || fromBlock <= 0) {
    throw new Error("manifest deploymentBlocks.depositPool is required for the fork snapshot");
  }
  const snapshotBlock = Number(sourceBlockNumber ?? await provider.getBlockNumber());
  if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < fromBlock) {
    throw new Error(`invalid source snapshot block ${snapshotBlock}`);
  }
  const at = { blockTag: snapshotBlock };
  // Polkadot Hub's EVM RPC rejects `null` topic placeholders. Query the
  // bounded, deployment-block-scoped Deposit stream and filter the indexed
  // owner locally instead of relying on an Ethereum-specific filter encoding.
  const depositFilter = pool.filters.Deposit();
  const [shares, assets, totalSupply, buffer, venuePrincipal, activeDeploy, activeRecall, depositEvents] = await Promise.all([
    pool.balanceOf(depositor, at),
    pool.assetsOf(depositor, at),
    pool.totalSupply(at),
    pool.bufferAssets(at),
    pool.venuePrincipalCostBasis(at),
    pool.activeVenueDeploymentId(at),
    pool.activeVenueRecallId(at),
    pool.queryFilter(depositFilter, fromBlock, snapshotBlock)
  ]);
  const walletDepositEvents = depositEvents.filter(
    (event) => ethers.getAddress(event.args.owner) === depositor
  );
  if (shares === 0n || shares !== totalSupply) {
    throw new Error(`the migration requires the single depositor to own the full supply (${shares}/${totalSupply})`);
  }
  if (venuePrincipal !== 0n || activeDeploy !== 0n || activeRecall !== 0n || buffer !== assets) {
    throw new Error("the v1 position is not fully recalled to its buffer; refuse a lossy migration rehearsal");
  }
  if (walletDepositEvents.length !== 1) {
    throw new Error(`expected exactly one surviving dogfood deposit event; found ${walletDepositEvents.length}`);
  }
  const event = walletDepositEvents[0];
  const block = await provider.getBlock(event.blockNumber);
  if (!block) throw new Error(`could not resolve source block ${event.blockNumber}`);
  const eventAssets = BigInt(event.args.assets);
  const eventShares = BigInt(event.args.shares);
  if (eventAssets !== assets || eventShares !== shares) {
    throw new Error(`the single deposit event does not reproduce the live position (${eventAssets}/${eventShares} vs ${assets}/${shares})`);
  }
  return {
    sourceBlockNumber: snapshotBlock,
    pool: poolAddress,
    wallet: depositor,
    sharesRaw: shares.toString(),
    assetsRaw: assets.toString(),
    principalRaw: assets.toString(),
    bufferRaw: buffer.toString(),
    activeVenueDeploymentId: activeDeploy.toString(),
    activeVenueRecallId: activeRecall.toString(),
    tranches: [{
      depositedRaw: eventAssets.toString(),
      remainingRaw: assets.toString(),
      depositedAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
      blockNumber: event.blockNumber,
      logIndex: event.index,
      txHash: event.transactionHash
    }]
  };
}

async function installForkUsdcShim({ provider, manifest, artifactsDir, snapshot, minter }) {
  const artifact = loadArtifact(artifactsDir, FORK_USDC_SHIM);
  const runtimePath = join(artifactsDir, FORK_USDC_SHIM[0], `${FORK_USDC_SHIM[1]}.json`);
  const parsed = JSON.parse(readFileSync(runtimePath, "utf8"));
  const runtime = parsed?.deployedBytecode?.object;
  if (typeof runtime !== "string" || !runtime.startsWith("0x") || runtime.length <= 2) {
    throw new Error(`missing fork USDC shim runtime in ${runtimePath}`);
  }
  const asset = ethers.getAddress(manifest.contracts.token);
  await provider.send("anvil_setCode", [asset, runtime]);
  const token = new ethers.Contract(asset, artifact.abi, minter);
  if (Number(await token.decimals()) !== 6) throw new Error("fork USDC shim does not expose six decimals");
  await (await token.mint(snapshot.pool, snapshot.bufferRaw)).wait();
  if (BigInt(await token.balanceOf(snapshot.pool)) !== BigInt(snapshot.bufferRaw)) {
    throw new Error("fork USDC shim did not reproduce the source pool buffer");
  }
  return token;
}

async function executeFork({ provider, sourceProvider, manifest, plan, deployer, wallet, artifactsDir }) {
  const network = await provider.getNetwork();
  if (network.chainId !== 31_337n && network.chainId !== 1_337n) {
    throw new Error(`--fork-execute refuses chainId ${network.chainId}; use an isolated Anvil fork`);
  }
  const sourceBlockNumber = await provider.getBlockNumber();
  const snapshot = await readLiveMigrationSnapshot({
    provider: sourceProvider,
    manifest,
    wallet,
    sourceBlockNumber
  });
  const deployerSigner = await impersonate(provider, deployer);
  // Shim setup must not consume a nonce from the predicted CREATE signer.
  const shimMinter = await impersonate(provider, "0x000000000000000000000000000000000000F00D");
  const token = await installForkUsdcShim({ provider, manifest, artifactsDir, snapshot, minter: shimMinter });
  const deployed = {};
  for (const [index, transaction] of plan.transactions.entries()) {
    // Bypass ethers' block-number cache: nonce equality is the CREATE safety
    // invariant and must be re-read from the fork before every deployment.
    const nonce = Number(await provider.send("eth_getTransactionCount", [deployer, "pending"]));
    const expectedNonce = Number(plan.startNonce) + index;
    if (nonce !== expectedNonce) throw new Error(`fork nonce drift before ${transaction.step}: ${nonce} != ${expectedNonce}`);
    const receipt = await (await deployerSigner.sendTransaction({ data: transaction.data, nonce })).wait();
    const actual = ethers.getAddress(receipt.contractAddress);
    if (actual !== ethers.getAddress(plan.predicted[transaction.step])) throw new Error(`${transaction.step} CREATE prediction drift`);
    deployed[transaction.step] = actual;
  }

  const oldPool = new ethers.Contract(manifest.contracts.depositPool, [
    "function balanceOf(address) view returns (uint256)",
    "function assetsOf(address) view returns (uint256)",
    "function redeem(uint256,address,address) returns (uint256)"
  ], provider);
  const depositor = snapshot.wallet;
  const [shares, assets] = [BigInt(snapshot.sharesRaw), BigInt(snapshot.assetsRaw)];
  if (shares === 0n) throw new Error("fork migration wallet has no v1 position");
  const walletSigner = await impersonate(provider, depositor);
  const oldWithdraw = await (await oldPool.connect(walletSigner).redeem(shares, depositor, depositor)).wait();

  // Preserve both economic assets and the exact share count. A temporary
  // operator seed establishes the v1 assets/share ratio, then exits atomically
  // after the depositor mints. It changes no depositor economics.
  const newPool = new ethers.Contract(deployed.depositPoolV2, plan.transactions[2].abi, provider);
  const operator = ethers.getAddress(manifest.verifier);
  const operatorSigner = await impersonate(provider, operator);
  await (await token.connect(deployerSigner).mint(operator, assets)).wait();
  await (await token.connect(operatorSigner).approve(deployed.depositPoolV2, shares)).wait();
  await (await newPool.connect(operatorSigner).deposit(shares, operator)).wait();
  if (assets < shares) throw new Error("migration cannot preserve a v1 share price below par without a loss write-down rehearsal");
  if (assets > shares) await (await token.connect(operatorSigner).transfer(deployed.depositPoolV2, assets - shares)).wait();
  await (await token.connect(walletSigner).approve(deployed.depositPoolV2, assets)).wait();
  const newDeposit = await (await newPool.connect(walletSigner).mint(shares, depositor)).wait();
  await (await newPool.connect(operatorSigner).redeem(shares, operator, operator)).wait();

  const [afterShares, afterAssets] = await Promise.all([newPool.balanceOf(depositor), newPool.assetsOf(depositor)]);
  if (afterShares !== shares || afterAssets !== assets) {
    throw new Error(`byte-exact position migration failed: ${afterShares}/${afterAssets} != ${shares}/${assets}`);
  }

  const policy = new ethers.Contract(manifest.contracts.treasuryPolicy, ["function owner() view returns (address)"], provider);
  const owner = await policy.owner();
  const ownerSigner = await impersonate(provider, owner);
  const wrapper = new ethers.Contract(manifest.contracts.xcmWrapper, [
    "function dispatchPaused() view returns (bool)",
    "function setDispatchPaused(bool)",
    "function setStrategyAdapter(bytes32,address)",
    "function strategyAdapter(bytes32) view returns (address)"
  ], provider);
  const pauseReceipts = [];
  if (!await wrapper.dispatchPaused()) pauseReceipts.push(await (await wrapper.connect(ownerSigner).setDispatchPaused(true)).wait());
  pauseReceipts.push(await (await wrapper.connect(ownerSigner).setStrategyAdapter(plan.strategyId, deployed.lane)).wait());
  pauseReceipts.push(await (await wrapper.connect(ownerSigner).setDispatchPaused(false)).wait());
  if (ethers.getAddress(await wrapper.strategyAdapter(plan.strategyId)) !== deployed.lane) {
    throw new Error("wrapper strategy pointer did not rewire to the v2 lane");
  }
  const positionAfter = {
    sharesRaw: afterShares.toString(),
    assetsRaw: afterAssets.toString(),
    principalRaw: snapshot.principalRaw,
    tranches: snapshot.tranches
  };
  assertByteExactMigration({ before: snapshot, after: positionAfter });
  const vestingMigration = buildVestingMigrationRecord({
    fromPool: snapshot.pool,
    toPool: deployed.depositPoolV2,
    wallet: depositor,
    oldWithdrawTx: oldWithdraw.hash,
    newDepositTx: newDeposit.hash,
    tranches: snapshot.tranches
  });
  return {
    sourceSnapshot: snapshot,
    deployed,
    position: { before: snapshot, after: positionAfter, byteExact: true },
    vestingMigration,
    migrationTransactions: {
      oldWithdrawTx: oldWithdraw.hash,
      newDepositTx: newDeposit.hash,
      wrapperRewireTxs: pauseReceipts.map((receipt) => receipt.hash)
    },
    postconditions: {
      oldPoolShares: (await oldPool.balanceOf(depositor)).toString(),
      oldPoolAssets: (await oldPool.assetsOf(depositor)).toString(),
      wrapperStrategyAdapter: await wrapper.strategyAdapter(plan.strategyId),
      wrapperDispatchPaused: await wrapper.dispatchPaused()
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(`deployments/${args.profile}.json`, "utf8"));
  const rpc = args.rpc ?? manifest.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpc);
  const sourceProvider = new ethers.JsonRpcProvider(args.sourceRpc ?? manifest.rpcUrl);
  const deployer = ethers.getAddress(args.deployer ?? manifest.contractProvenance?.[manifest.contracts.depositPool]?.deployer ?? manifest.deployer);
  const startNonce = await provider.getTransactionCount(deployer, "pending");
  const built = buildDeploymentPlan({ manifest, deployer, startNonce, artifactsDir: args.artifacts });
  const plan = { schemaVersion: 1, kind: "averray.creditPoolL1MigrationForkPlan", rpc, deployer, startNonce, ...built };
  if (!args.forkExecute) {
    console.log(JSON.stringify({
      ...plan,
      transactions: plan.transactions.map(({ abi: _abi, ...transaction }) => transaction),
      wrapperConfiguration: {
        wrapper: plan.wrapperConfiguration.wrapper,
        strategyId: plan.wrapperConfiguration.strategyId,
        adapter: plan.wrapperConfiguration.adapter
      },
      execution: "dry-run; no transaction signed or broadcast",
      next: "Run only against an isolated Anvil fork with --fork-execute --wallet <single dogfood depositor>."
    }, null, 2));
    return;
  }
  const wallet = args.wallet ?? LIVE_DOGFOOD_DEPOSITOR;
  console.log(JSON.stringify(await executeFork({
    provider,
    sourceProvider,
    manifest,
    plan,
    deployer,
    wallet,
    artifactsDir: args.artifacts
  }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`CreditPool migration rehearsal failed: ${error.message}`);
    process.exitCode = 1;
  });
}
