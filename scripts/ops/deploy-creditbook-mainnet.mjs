#!/usr/bin/env node
/**
 * Guarded CreditBook replacement ceremony. Read-only unless --commit.
 *
 * The deployment is CREATE-only: it does not seed, alter AgentAccountCore,
 * change policy, or wire the backend. Funding remains the separate EOA flow
 * AAC.deposit -> AAC.sendToAgent(book) -> CreditBook.seed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  keccak256
} from "ethers";

import { resolveCeremonyDeployer } from "./deploy-deposit-pool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const EXPECTED_CHAIN_ID = 420_420_419n;
const EXPECTED_DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
const ABANDONED_CREDIT_BOOK = "0xdB7bF8caB8160d33b3B0943F9d671C207DD46d60";
const MINIMUM_DEPLOYER_BALANCE_WEI = 2_500_000_000_000_000_000n;
const ARTIFACT_PATH = resolve(repoRoot, "out/CreditBook.sol/CreditBook.json");

export function parseArgs(argv) {
  const args = { commit: false, profile: undefined, artifacts: "out" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--rpc") args.rpc = argv[++index];
    else if (token === "--expected-deployer") args.expectedDeployer = argv[++index];
    else if (token === "--signer-secret-ref") args.signerSecretRef = argv[++index];
    else if (token === "--source-commit") args.sourceCommit = argv[++index];
    else if (token === "--expected-start-nonce") args.expectedStartNonce = Number(argv[++index]);
    else if (token === "--expected-creation-code-hash") args.expectedCreationCodeHash = argv[++index];
    else if (token === "--confirmation") args.confirmation = argv[++index];
    else if (token === "--evidence-out") args.evidenceOut = argv[++index];
    else if (token === "--commit") args.commit = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is required (no default).");
  return args;
}

export function sha256Hex(value) {
  const bytes = Buffer.from(String(value).replace(/^0x/u, ""), "hex");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertPinnedCreationCode(actual, expected, commit) {
  if (!expected) {
    if (commit) throw new Error("--expected-creation-code-hash is required for --commit.");
    return;
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(expected)) {
    throw new Error("--expected-creation-code-hash must be sha256:<64 lowercase hex>.");
  }
  if (actual !== expected) {
    throw new Error(`creation code hash ${actual} does not match pinned ${expected}.`);
  }
}

export async function buildDeploymentPlan({ artifact, bindings, deployer, startNonce }) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object);
  const transaction = await factory.getDeployTransaction(
    bindings.policy,
    bindings.accounts,
    bindings.asset,
    bindings.operator,
    ZeroAddress
  );
  const inputs = factory.interface.deploy.inputs.map((input) => input.type);
  const encodedArgs = `0x${transaction.data.slice(artifact.bytecode.object.length)}`;
  const decoded = AbiCoder.defaultAbiCoder().decode(inputs, encodedArgs);
  return {
    startNonce,
    predictedAddress: getCreateAddress({ from: deployer, nonce: startNonce }),
    creationCodeHash: sha256Hex(artifact.bytecode.object),
    deploymentDataHash: keccak256(transaction.data),
    transactionData: transaction.data,
    decodedBindings: {
      policy: getAddress(decoded[0]),
      accounts: getAddress(decoded[1]),
      asset: getAddress(decoded[2]),
      operator: getAddress(decoded[3]),
      initialL3PosterWallet: getAddress(decoded[4])
    }
  };
}

export function assertBindings(actual, expected) {
  const mismatches = [];
  for (const field of ["policy", "accounts", "asset", "operator"]) {
    if (getAddress(actual[field]) !== getAddress(expected[field])) {
      mismatches.push(`${field}=${actual[field]} expected ${expected[field]}`);
    }
  }
  const exact = {
    cashPerWalletCapRaw: 25_000_000n,
    postingPerWalletCapRaw: 25_000_000n,
    bookCapRaw: 50_000_000n,
    interestBps: 0n,
    repayBps: 5_000n,
    accountedLiquidityRaw: 0n,
    totalOutstandingRaw: 0n
  };
  for (const [field, expectedValue] of Object.entries(exact)) {
    if (BigInt(actual[field]) !== expectedValue) {
      mismatches.push(`${field}=${actual[field]} expected ${expectedValue}`);
    }
  }
  if (actual.l3Enabled !== false) mismatches.push("l3Enabled must be false");
  if (getAddress(actual.l3PosterWallet) !== ZeroAddress) mismatches.push("l3PosterWallet must be zero");
  if (mismatches.length > 0) throw new Error(`CreditBook binding mismatch: ${mismatches.join("; ")}`);
}

function sourceCheckout(sourceCommit) {
  if (!/^[0-9a-f]{40}$/u.test(String(sourceCommit ?? ""))) {
    throw new Error("--source-commit must be the full reviewed commit.");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  if (head !== sourceCommit) throw new Error(`checkout HEAD ${head} does not match --source-commit ${sourceCommit}.`);
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
  if (dirty) throw new Error("checkout is dirty; refusing to deploy uncommitted CreditBook bytecode.");
}

function loadArtifact() {
  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(`missing ${ARTIFACT_PATH}; run forge build --skip test first.`);
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  if (!artifact?.bytecode?.object?.startsWith("0x") || !Array.isArray(artifact.abi)) {
    throw new Error("CreditBook artifact is malformed.");
  }
  return artifact;
}

async function readBindings(book) {
  const [
    policy,
    accounts,
    asset,
    operator,
    cashPerWalletCapRaw,
    postingPerWalletCapRaw,
    bookCapRaw,
    interestBps,
    repayBps,
    accountedLiquidityRaw,
    totalOutstandingRaw,
    l3Enabled,
    l3PosterWallet
  ] = await Promise.all([
    book.policy(),
    book.accounts(),
    book.asset(),
    book.operator(),
    book.cashPerWalletCapRaw(),
    book.postingPerWalletCapRaw(),
    book.bookCapRaw(),
    book.interestBps(),
    book.repayBps(),
    book.accountedLiquidityRaw(),
    book.totalOutstandingRaw(),
    book.l3Enabled(),
    book.l3PosterWallet()
  ]);
  return {
    policy,
    accounts,
    asset,
    operator,
    cashPerWalletCapRaw,
    postingPerWalletCapRaw,
    bookCapRaw,
    interestBps,
    repayBps,
    accountedLiquidityRaw,
    totalOutstandingRaw,
    l3Enabled,
    l3PosterWallet
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("deploy-creditbook-mainnet.mjs --profile mainnet --expected-deployer 0x… --source-commit <sha> [--commit guards]");
    return;
  }
  sourceCheckout(args.sourceCommit);
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "deployments/mainnet.json"), "utf8"));
  const provider = new JsonRpcProvider(args.rpc ?? manifest.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`profile expects chain ${EXPECTED_CHAIN_ID}; RPC reports ${network.chainId}.`);
  }
  const deployerIdentity = resolveCeremonyDeployer({
    expectedDeployer: args.expectedDeployer,
    signerSecretRef: args.signerSecretRef,
    commit: args.commit
  });
  if (deployerIdentity.address !== EXPECTED_DEPLOYER) {
    throw new Error(`CreditBook ceremony deployer must be ${EXPECTED_DEPLOYER}.`);
  }
  const startNonce = await provider.getTransactionCount(deployerIdentity.address, "pending");
  if (args.expectedStartNonce !== undefined && startNonce !== args.expectedStartNonce) {
    throw new Error(`pending nonce ${startNonce} != --expected-start-nonce ${args.expectedStartNonce}.`);
  }
  if (args.commit && args.expectedStartNonce === undefined) {
    throw new Error("--expected-start-nonce is required for --commit.");
  }
  const balance = await provider.getBalance(deployerIdentity.address);
  const fundingShortfallWei = balance < MINIMUM_DEPLOYER_BALANCE_WEI
    ? MINIMUM_DEPLOYER_BALANCE_WEI - balance
    : 0n;

  const abandonedCode = await provider.getCode(ABANDONED_CREDIT_BOOK);
  if (abandonedCode === "0x") throw new Error(`abandoned CreditBook ${ABANDONED_CREDIT_BOOK} has no code.`);
  const artifact = loadArtifact();
  const abandoned = new Contract(ABANDONED_CREDIT_BOOK, artifact.abi, provider);
  const [oldAccounted, oldOutstanding, oldLiquid] = await Promise.all([
    abandoned.accountedLiquidityRaw(),
    abandoned.totalOutstandingRaw(),
    abandoned.bookLiquidRaw()
  ]);
  if (oldAccounted !== 0n || oldOutstanding !== 0n || oldLiquid !== 0n) {
    throw new Error(
      `abandoned CreditBook is not inert: accounted=${oldAccounted} outstanding=${oldOutstanding} liquid=${oldLiquid}.`
    );
  }

  const bindings = {
    policy: getAddress(manifest.contracts.treasuryPolicy),
    accounts: getAddress(manifest.contracts.agentAccountCore),
    asset: getAddress(manifest.contracts.token),
    operator: getAddress(manifest.verifier)
  };
  const plan = await buildDeploymentPlan({ artifact, bindings, deployer: deployerIdentity.address, startNonce });
  assertBindings(
    {
      ...plan.decodedBindings,
      cashPerWalletCapRaw: 25_000_000n,
      postingPerWalletCapRaw: 25_000_000n,
      bookCapRaw: 50_000_000n,
      interestBps: 0n,
      repayBps: 5_000n,
      accountedLiquidityRaw: 0n,
      totalOutstandingRaw: 0n,
      l3Enabled: false,
      l3PosterWallet: ZeroAddress
    },
    bindings
  );
  assertPinnedCreationCode(plan.creationCodeHash, args.expectedCreationCodeHash, args.commit);
  const preview = {
    mode: args.commit ? "commit" : "dry_run",
    sourceCommit: args.sourceCommit,
    chainId: network.chainId.toString(),
    deployer: deployerIdentity.address,
    deployerBalanceWei: balance.toString(),
    minimumDeployerBalanceWei: MINIMUM_DEPLOYER_BALANCE_WEI.toString(),
    fundingReady: fundingShortfallWei === 0n,
    fundingShortfallWei: fundingShortfallWei.toString(),
    startNonce,
    abandonedCreditBook: ABANDONED_CREDIT_BOOK,
    abandonedState: { accountedLiquidityRaw: "0", totalOutstandingRaw: "0", bookLiquidRaw: "0" },
    predictedAddress: plan.predictedAddress,
    creationCodeHash: plan.creationCodeHash,
    deploymentDataHash: plan.deploymentDataHash,
    constructor: plan.decodedBindings
  };
  console.log(JSON.stringify(preview, null, 2));
  if (fundingShortfallWei !== 0n) {
    throw new Error(
      `deployer balance ${balance} is below the 2.5 DOT ceremony floor by ${fundingShortfallWei} wei.`
    );
  }
  if (!args.commit) return;

  const confirmation = `DEPLOY CREDITBOOK ${plan.predictedAddress}`;
  if (args.confirmation !== confirmation) {
    throw new Error(`--confirmation must equal ${JSON.stringify(confirmation)}.`);
  }
  if (!args.evidenceOut) throw new Error("--evidence-out is required for --commit.");
  const evidencePath = resolve(repoRoot, args.evidenceOut);
  if (!evidencePath.startsWith(`${repoRoot}/`) || existsSync(evidencePath)) {
    throw new Error("--evidence-out must be a fresh path inside this checkout.");
  }
  const nonceNow = await provider.getTransactionCount(deployerIdentity.address, "pending");
  if (nonceNow !== startNonce) throw new Error(`nonce drift before CREATE: ${nonceNow} != ${startNonce}.`);
  const signer = deployerIdentity.wallet.connect(provider);
  const sent = await signer.sendTransaction({ data: plan.transactionData, nonce: startNonce });
  const receipt = await sent.wait();
  if (receipt?.status !== 1) throw new Error("CreditBook CREATE receipt failed.");
  if (getAddress(receipt.contractAddress) !== plan.predictedAddress) {
    throw new Error(`deployed address ${receipt.contractAddress} != predicted ${plan.predictedAddress}.`);
  }
  const deployed = new Contract(plan.predictedAddress, artifact.abi, provider);
  const actualBindings = await readBindings(deployed);
  assertBindings(actualBindings, bindings);
  const runtimeCode = await provider.getCode(plan.predictedAddress);
  const evidence = {
    ...preview,
    mode: "committed",
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    runtimeCodeHash: sha256Hex(runtimeCode),
    abiHash: `sha256:${createHash("sha256").update(JSON.stringify(artifact.abi)).digest("hex")}`,
    verifiedBindings: Object.fromEntries(
      Object.entries(actualBindings).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])
    )
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`deployment evidence: ${args.evidenceOut}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`CreditBook ceremony failed: ${error.message}`);
    process.exitCode = 1;
  });
}
