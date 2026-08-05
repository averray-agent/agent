import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";

export const BANK_XCM_V2 = Object.freeze({
  profile: "mainnet",
  chainId: 420420419,
  hydrationParaId: 2034,
  assetHubParaId: 1000,
  hydrationUsdcAssetId: 22,
  hydrationAUsdcAssetId: 1003,
  hydrationRouterPalletIndex: 235,
  hydrationRouterCallIndex: 0,
  strategyLabel: "HYDRATION_USDC_V1",
  strategyId: `0x${Buffer.from("HYDRATION_USDC_V1", "utf8").toString("hex").padEnd(64, "0")}`,
  xcmPrecompile: "0x00000000000000000000000000000000000A0000",
  aUsdcContract: "0x2ec4884088d84e5c2970a034732e5209b0acfa93",
  observerAssetEndpoint: "wss://hydration-rpc.n.dwellir.com",
  observerEvmEndpoint: "https://rpc.hydradx.cloud",
  assetHubWs: "wss://polkadot-asset-hub-rpc.polkadot.io",
  hydrationConversionEndpoints: Object.freeze([
    "https://rpc.kril.hydration.cloud",
    "https://rpc-catfish-1.catfish.hydration.cloud"
  ]),
  localDestination: "0x050000",
  hydrationDestination: "0x05010100c91f"
});

export const BANK_XCM_V2_RECOVERY_DOMAIN = `0x${Buffer.from("HYDRATION_USDC_RECOVERY_V1", "utf8").toString("hex").padEnd(64, "0")}`;

export const WRAPPER_ADMIN_ABI = Object.freeze([
  "function policy() view returns (address)",
  "function xcmPrecompile() view returns (address)",
  "function operator() view returns (address)",
  "function hydrationAccountId32() view returns (bytes32)",
  "function dispatchPaused() view returns (bool)",
  "function strategyAdapter(bytes32) view returns (address)",
  "function setOperator(address)",
  "function setStrategyAdapter(bytes32,address)",
  "function setHydrationAccountId32(bytes32)",
  "function setDispatchPaused(bool)"
]);

export const ADAPTER_ADMIN_ABI = Object.freeze([
  "function policy() view returns (address)",
  "function asset() view returns (address)",
  "function strategyId() view returns (bytes32)",
  "function xcmWrapper() view returns (address)",
  "function agentAccountCore() view returns (address)"
]);

export const POLICY_BANK_ABI = Object.freeze([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function strategySettler(address) view returns (bool)",
  "function setStrategySettler(address,bool)"
]);

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256Hex(value) {
  const bytes = typeof value === "string" && value.startsWith("0x")
    ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function artifactEvidence(artifact) {
  const bytecode = artifact?.bytecode?.object;
  const runtime = artifact?.deployedBytecode?.object;
  if (!Array.isArray(artifact?.abi) || !/^0x[0-9a-f]+$/iu.test(bytecode ?? "") || !/^0x[0-9a-f]+$/iu.test(runtime ?? "")) {
    throw new Error("Foundry artifact is missing ABI, bytecode, or deployed bytecode; run forge build first.");
  }
  return {
    abiHash: sha256Hex(JSON.stringify(artifact.abi)),
    creationCodeHash: sha256Hex(bytecode),
    compiledRuntimeCodeHash: sha256Hex(runtime),
    creationBytes: (bytecode.length - 2) / 2,
    runtimeBytes: (runtime.length - 2) / 2
  };
}

export function wrapperAccountId32(wrapperAddress) {
  return `0x${getAddress(wrapperAddress).slice(2).toLowerCase()}${"ee".repeat(12)}`;
}

export function truncateAccountId32(accountId32) {
  assertBytes32(accountId32, "Hydration converted AccountId32");
  return getAddress(`0x${accountId32.slice(2, 42)}`);
}

export function assertBytes32(value, label) {
  if (!/^0x[0-9a-f]{64}$/iu.test(String(value))) {
    throw new Error(`${label} must be 0x-prefixed bytes32.`);
  }
  return value;
}

export function compact(valueInput) {
  const value = BigInt(valueInput);
  if (value < 0n) throw new Error("compact value must be non-negative.");
  if (value < 64n) return Buffer.from([Number(value << 2n)]);
  if (value < 16_384n) {
    const raw = (value << 2n) | 1n;
    return Buffer.from([Number(raw & 0xffn), Number((raw >> 8n) & 0xffn)]);
  }
  if (value < 1_073_741_824n) {
    const raw = (value << 2n) | 2n;
    return Buffer.from([
      Number(raw & 0xffn),
      Number((raw >> 8n) & 0xffn),
      Number((raw >> 16n) & 0xffn),
      Number((raw >> 24n) & 0xffn)
    ]);
  }
  throw new Error("ceremony compact value exceeds the v2 reviewed 30-bit grammar.");
}

function leU128(valueInput) {
  let value = BigInt(valueInput);
  if (value < 0n || value >= (1n << 128n)) throw new Error("u128 value is out of range.");
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function hexBuffer(value, label) {
  if (!/^0x(?:[0-9a-f]{2})*$/iu.test(String(value))) throw new Error(`${label} must be even-length hex.`);
  return Buffer.from(value.slice(2), "hex");
}

function concatHex(...parts) {
  return `0x${Buffer.concat(parts).toString("hex")}`;
}

export function previewRequestId(context) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [
      context.strategyId,
      context.kind,
      context.account,
      context.asset,
      context.recipient,
      context.assets,
      context.shares,
      context.nonce
    ]
  ));
}

export function previewRecoveryHomeId({ wrapper, convertedAccountId32, amount, nonce }) {
  if (!isAddress(wrapper)) throw new Error("recovery wrapper must be an H160 address.");
  assertBytes32(convertedAccountId32, "recovery convertedAccountId32");
  const recoveryAmount = BigInt(amount);
  const recoveryNonce = BigInt(nonce);
  if (recoveryAmount <= 0n || recoveryNonce <= 0n || recoveryNonce > ((1n << 64n) - 1n)) {
    throw new Error("recovery amount and uint64 nonce must be positive.");
  }
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "bytes32", "uint256", "uint64"],
    [BANK_XCM_V2_RECOVERY_DOMAIN, getAddress(wrapper), convertedAccountId32, recoveryAmount, recoveryNonce]
  ));
}

export function buildRecoveryHomeMessage({ wrapper, convertedAccountId32, amount, fee, nonce }) {
  const wrapperAddress = getAddress(wrapper);
  const recoveryAmount = BigInt(amount);
  const recoveryFee = BigInt(fee);
  const recoveryId = previewRecoveryHomeId({
    wrapper: wrapperAddress,
    convertedAccountId32,
    amount: recoveryAmount,
    nonce
  });
  if (recoveryFee <= 0n || recoveryFee > recoveryAmount) {
    throw new Error("recovery fee must be positive and no greater than the recovered amount.");
  }
  const wrapperAccount = hexBuffer(wrapperAccountId32(wrapperAddress), "wrapperAccountId32");
  const message = concatHex(
    hexBuffer("0x05140004010300a10f043205e51400", "recovery outer amount prefix"), compact(recoveryAmount),
    hexBuffer("0x13010300a10f043205e51400", "recovery repeated amount prefix"), compact(recoveryAmount),
    hexBuffer("0x001410010204010100a10f08130002043205e51400", "recovery reserve prefix"), compact(recoveryFee),
    hexBuffer("0x000d01020400010100", "recovery beneficiary prefix"), wrapperAccount,
    Buffer.from([0x2c]), hexBuffer(recoveryId, "recovery id")
  );
  return {
    label: "recovery_home",
    chain: "hydration",
    destination: BANK_XCM_V2.hydrationDestination,
    message,
    requestId: recoveryId,
    recoveryId,
    amount: recoveryAmount,
    fee: recoveryFee,
    nonce: BigInt(nonce),
    messageHash: keccak256(message),
    expected: {
      forwardedParaId: BANK_XCM_V2.assetHubParaId,
      remoteEvent: "Assets.Deposited",
      assetId: 1337
    }
  };
}

export function buildBankXcmV2Messages({
  wrapper,
  convertedAccountId32,
  asset,
  treasuryContext,
  depositAssets = 150_000n,
  depositSellAmount = 100_000n,
  depositFee = 20_917n,
  withdrawShares = 100_000n,
  withdrawFee = 21_350n,
  homeAmount = 100_000n,
  homeFee = 1_402n,
  depositNonce = 1n,
  withdrawNonce = 2n
}) {
  if (!isAddress(wrapper) || !isAddress(asset) || !isAddress(treasuryContext)) {
    throw new Error("wrapper, asset, and treasuryContext must be H160 addresses.");
  }
  assertBytes32(convertedAccountId32, "convertedAccountId32");
  const amounts = {
    depositAssets: BigInt(depositAssets),
    depositSellAmount: BigInt(depositSellAmount),
    depositFee: BigInt(depositFee),
    withdrawShares: BigInt(withdrawShares),
    withdrawFee: BigInt(withdrawFee),
    homeAmount: BigInt(homeAmount),
    homeFee: BigInt(homeFee)
  };
  if (Object.values(amounts).some((value) => value <= 0n)) {
    throw new Error("all four-leg amounts and fee budgets must be positive.");
  }
  if (amounts.depositSellAmount + amounts.depositFee > amounts.depositAssets) {
    throw new Error("deposit sell amount plus fee exceeds the funded request assets.");
  }
  if (amounts.homeFee > amounts.homeAmount) {
    throw new Error("withdraw_home fee exceeds the request-bound return amount.");
  }
  if (BigInt(homeAmount) !== BigInt(withdrawShares)) {
    throw new Error("withdraw_home amount must equal the Withdraw request shares; any Aave yield remains visible as converted-account operating float.");
  }
  const wrapperId = wrapperAccountId32(wrapper);
  const depositContext = {
    strategyId: BANK_XCM_V2.strategyId,
    kind: 0,
    account: getAddress(treasuryContext),
    asset: getAddress(asset),
    recipient: getAddress(treasuryContext),
    assets: amounts.depositAssets,
    shares: 0n,
    nonce: BigInt(depositNonce)
  };
  const withdrawContext = {
    strategyId: BANK_XCM_V2.strategyId,
    kind: 1,
    account: getAddress(treasuryContext),
    asset: getAddress(asset),
    recipient: getAddress(treasuryContext),
    assets: 0n,
    shares: amounts.withdrawShares,
    nonce: BigInt(withdrawNonce)
  };
  const depositRequestId = previewRequestId(depositContext);
  const withdrawRequestId = previewRequestId(withdrawContext);
  const hydration = hexBuffer(convertedAccountId32, "convertedAccountId32");
  const wrapperAccount = hexBuffer(wrapperId, "wrapperAccountId32");

  const funding = concatHex(
    hexBuffer("0x051000040002043205e51400", "fund prefix"), compact(depositAssets),
    hexBuffer("0x2b010e00040002043205e51400", "fund nested prefix"), compact(depositAssets),
    hexBuffer("0x010100c91f0813010300a10f043205e51400", "fund reserve prefix"), compact(depositAssets),
    hexBuffer("0x000d01020400010100", "fund beneficiary prefix"), hydration,
    Buffer.from([0x2c]), hexBuffer(depositRequestId, "deposit request id")
  );
  const sell = ({ withdraw, fee, amount, requestId }) => concatHex(
    hexBuffer("0x05180004010300a10f043205e51400", "sell fee prefix"), compact(fee),
    hexBuffer("0x13010300a10f043205e51400", "sell repeated fee prefix"), compact(fee),
    hexBuffer("0x000601010700c817a80482841e00d04300", "sell transact prefix"),
    hexBuffer(withdraw ? "0xeb03000016000000" : "0x16000000eb030000", "sell assets"),
    leU128(amount), Buffer.alloc(16),
    hexBuffer(withdraw ? "0x0404eb03000016000000140d01020400010100" : "0x040416000000eb030000140d01020400010100", "sell appendix"),
    hydration, Buffer.from([0x2c]), hexBuffer(requestId, "sell request id")
  );
  const home = concatHex(
    hexBuffer("0x05140004010300a10f043205e51400", "home outer amount prefix"), compact(homeAmount),
    hexBuffer("0x13010300a10f043205e51400", "home repeated amount prefix"), compact(homeAmount),
    hexBuffer("0x001410010204010100a10f08130002043205e51400", "home reserve prefix"), compact(homeFee),
    hexBuffer("0x000d01020400010100", "home beneficiary prefix"), wrapperAccount,
    Buffer.from([0x2c]), hexBuffer(withdrawRequestId, "withdraw request id")
  );

  const make = (label, chain, destination, message, requestId, expected) => ({
    label,
    chain,
    destination,
    message,
    requestId,
    messageHash: keccak256(message),
    expected
  });
  return {
    wrapper: getAddress(wrapper),
    wrapperAccountId32: wrapperId,
    convertedAccountId32,
    convertedH160: truncateAccountId32(convertedAccountId32),
    contexts: { deposit: depositContext, withdraw: withdrawContext },
    messages: [
      make("deposit_funding", "asset_hub", BANK_XCM_V2.localDestination, funding, depositRequestId, {
        forwardedParaId: BANK_XCM_V2.hydrationParaId,
        remoteEvent: "Tokens.Deposited",
        assetId: BANK_XCM_V2.hydrationUsdcAssetId
      }),
      make("deposit_sell", "hydration", BANK_XCM_V2.hydrationDestination, sell({ withdraw: false, fee: depositFee, amount: depositSellAmount, requestId: depositRequestId }), depositRequestId, {
        event: "Broadcast.Swapped",
        fillerType: "AAVE",
        assetIn: BANK_XCM_V2.hydrationUsdcAssetId,
        assetOut: BANK_XCM_V2.hydrationAUsdcAssetId
      }),
      make("withdraw_sell", "hydration", BANK_XCM_V2.hydrationDestination, sell({ withdraw: true, fee: withdrawFee, amount: withdrawShares, requestId: withdrawRequestId }), withdrawRequestId, {
        event: "Broadcast.Swapped",
        fillerType: "AAVE",
        assetIn: BANK_XCM_V2.hydrationAUsdcAssetId,
        assetOut: BANK_XCM_V2.hydrationUsdcAssetId
      }),
      make("withdraw_home", "hydration", BANK_XCM_V2.hydrationDestination, home, withdrawRequestId, {
        forwardedParaId: BANK_XCM_V2.assetHubParaId,
        remoteEvent: "Assets.Deposited",
        assetId: 1337
      })
    ]
  };
}

export function buildConfigurationCalls({ manifest, wrapper, adapter, convertedAccountId32 }) {
  const wrapperAddress = getAddress(wrapper);
  const adapterAddress = getAddress(adapter);
  assertBytes32(convertedAccountId32, "convertedAccountId32");
  const policy = getAddress(manifest.contracts.treasuryPolicy);
  const operator = getAddress(manifest.verifier);
  const wrapperIface = new Interface(WRAPPER_ADMIN_ABI);
  const policyIface = new Interface(POLICY_BANK_ABI);
  return [
    {
      label: `XcmWrapperV2.setHydrationAccountId32(${convertedAccountId32})`,
      to: wrapperAddress,
      data: wrapperIface.encodeFunctionData("setHydrationAccountId32", [convertedAccountId32])
    },
    {
      label: `XcmWrapperV2.setOperator(${operator})`,
      to: wrapperAddress,
      data: wrapperIface.encodeFunctionData("setOperator", [operator])
    },
    {
      label: `XcmWrapperV2.setStrategyAdapter(${BANK_XCM_V2.strategyId}, ${adapterAddress})`,
      to: wrapperAddress,
      data: wrapperIface.encodeFunctionData("setStrategyAdapter", [BANK_XCM_V2.strategyId, adapterAddress])
    },
    {
      label: `TreasuryPolicy.setStrategySettler(${operator}, true)`,
      to: policy,
      data: policyIface.encodeFunctionData("setStrategySettler", [operator, true])
    }
  ];
}

export function buildArmCalls({ wrapper }) {
  const wrapperAddress = getAddress(wrapper);
  const wrapperIface = new Interface(WRAPPER_ADMIN_ABI);
  return [{
    label: "XcmWrapperV2.setDispatchPaused(false)",
    to: wrapperAddress,
    data: wrapperIface.encodeFunctionData("setDispatchPaused", [false])
  }];
}

export function buildSuccessionCalls({ previousWrapper, wrapper }) {
  const previousWrapperAddress = getAddress(previousWrapper);
  const wrapperAddress = getAddress(wrapper);
  if (previousWrapperAddress === wrapperAddress) {
    throw new Error("Bank wrapper succession requires two distinct generations.");
  }
  const wrapperIface = new Interface(WRAPPER_ADMIN_ABI);
  return [
    {
      label: `XcmWrapperV22(${previousWrapperAddress}).setDispatchPaused(true)`,
      to: previousWrapperAddress,
      data: wrapperIface.encodeFunctionData("setDispatchPaused", [true])
    },
    {
      label: `XcmWrapperV22(${wrapperAddress}).setDispatchPaused(false)`,
      to: wrapperAddress,
      data: wrapperIface.encodeFunctionData("setDispatchPaused", [false])
    }
  ];
}

export function applyBankXcmV2Manifest(manifest, evidence) {
  const next = structuredClone(manifest);
  const version = String(evidence.version ?? "").trim();
  if (!/^2(?:\.[0-9]+){0,2}$/u.test(version)) {
    throw new Error("Bank XCM deployment evidence version must identify a v2 generation.");
  }
  const wrapper = getAddress(evidence.wrapper.address);
  const adapter = getAddress(evidence.adapter.address);
  const previousWrapper = isAddress(next.contracts?.xcmWrapper) ? getAddress(next.contracts.xcmWrapper) : null;
  const previousAdapter = isAddress(next.contracts?.hydrationUsdcAdapter)
    ? getAddress(next.contracts.hydrationUsdcAdapter)
    : null;
  const verifiedAt = evidence.verifiedAt;
  const sourceCommit = String(evidence.sourceCommit ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("sourceCommit must be a full 40-character commit.");
  if (!Number.isInteger(evidence.wrapper.blockNumber) || !Number.isInteger(evidence.adapter.blockNumber)) {
    throw new Error("both deployment block numbers are required.");
  }
  for (const entry of [evidence.wrapper, evidence.adapter]) {
    if (!/^0x[0-9a-f]{64}$/iu.test(entry.txHash) || !/^sha256:[0-9a-f]{64}$/u.test(entry.abiHash) || !/^sha256:[0-9a-f]{64}$/u.test(entry.runtimeCodeHash)) {
      throw new Error("deployment evidence has an invalid transaction or provenance hash.");
    }
  }
  const history = [...(next.bankXcmDeploymentHistory ?? [])];
  if (previousWrapper && previousAdapter && (previousWrapper !== wrapper || previousAdapter !== adapter)) {
    const previousRecorded = history.some((entry) => (
      isAddress(entry?.wrapper) && getAddress(entry.wrapper) === previousWrapper
    ));
    if (!previousRecorded) {
      history.push({
        version: next.bankXcmV2Deployment?.version ?? "2.0",
        status: "retired_replaced",
        wrapper: previousWrapper,
        adapter: previousAdapter,
        deployTxHashes: next.bankXcmV2Deployment?.deployTxHashes ?? null,
        ...(next.bankXcmV2Deployment?.convertedAccountId32
          ? { convertedAccountId32: next.bankXcmV2Deployment.convertedAccountId32 }
          : {}),
        replacementReason: evidence.replacementReason ?? "superseded by a reviewed Bank wrapper deployment",
        incident: next.bankXcmV2Deployment?.incident ?? null,
        retiredCapital: evidence.retiredCapital ?? next.bankXcmV2Deployment?.incident?.writeOffs ?? []
      });
    }
  }
  if (history.some((entry) => isAddress(entry?.wrapper) && getAddress(entry.wrapper) === wrapper)) {
    throw new Error(`Bank XCM wrapper ${wrapper} is already present in append-only deployment history.`);
  }
  history.push({
    version,
    status: "deployed_paused",
    wrapper,
    adapter,
    deployTxHashes: { wrapper: evidence.wrapper.txHash, adapter: evidence.adapter.txHash },
    ...(evidence.convertedAccountId32 ? { convertedAccountId32: evidence.convertedAccountId32 } : {}),
    replacementReason: evidence.replacementReason ?? null
  });
  next.bankXcmDeploymentHistory = history;
  next.contracts = { ...next.contracts, xcmWrapper: wrapper, hydrationUsdcAdapter: adapter };
  next.contractProvenance = {
    ...next.contractProvenance,
    [wrapper]: { sourceCommit, abiHash: evidence.wrapper.abiHash, runtimeCodeHash: evidence.wrapper.runtimeCodeHash, verifiedAt },
    [adapter]: { sourceCommit, abiHash: evidence.adapter.abiHash, runtimeCodeHash: evidence.adapter.runtimeCodeHash, verifiedAt }
  };
  const generationSuffix = version === "2" || version === "2.0"
    ? "V2"
    : `V${version.replaceAll(".", "_")}`;
  next.deploymentBlocks = {
    ...next.deploymentBlocks,
    [`xcmWrapper${generationSuffix}`]: evidence.wrapper.blockNumber,
    [generationSuffix === "V2" ? "hydrationUsdcAdapter" : `hydrationUsdcAdapter${generationSuffix}`]: evidence.adapter.blockNumber
  };
  next.deployers = {
    ...next.deployers,
    [`xcmWrapper${generationSuffix}`]: getAddress(evidence.deployer),
    [generationSuffix === "V2" ? "hydrationUsdcAdapter" : `hydrationUsdcAdapter${generationSuffix}`]: getAddress(evidence.deployer)
  };
  next.strategies = (next.strategies ?? []).filter((entry) => entry?.id !== BANK_XCM_V2.strategyLabel);
  next.strategies.push({
    id: BANK_XCM_V2.strategyLabel,
    adapter,
    wrapper,
    asset: getAddress(next.contracts.token),
    phase: "phase1_treasury_staging",
    status: "paused_pending_dust_proof",
    remote: {
      paraId: BANK_XCM_V2.hydrationParaId,
      assetId: BANK_XCM_V2.hydrationUsdcAssetId,
      shareAssetId: BANK_XCM_V2.hydrationAUsdcAssetId,
      routerPalletIndex: BANK_XCM_V2.hydrationRouterPalletIndex,
      routerCallIndex: BANK_XCM_V2.hydrationRouterCallIndex,
      aUsdcContract: BANK_XCM_V2.aUsdcContract
    }
  });
  next.bankXcmV2Deployment = {
    version,
    status: "deployed_paused",
    deployTxHashes: { wrapper: evidence.wrapper.txHash, adapter: evidence.adapter.txHash },
    configurationMultisigExecTx: evidence.configurationMultisigExecTx ?? null,
    convertedAccountId32: evidence.convertedAccountId32 ?? null,
    conversionEvidence: evidence.conversionEvidence ?? null,
    dryRunEvidence: evidence.dryRunEvidence ?? [],
    dustCycleEvidence: null
  };
  return next;
}

export function deterministicRequestTopic(label, wrapper) {
  return keccak256(toUtf8Bytes(`${label}:${getAddress(wrapper)}`));
}
