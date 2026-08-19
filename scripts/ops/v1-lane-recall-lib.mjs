import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256 } from "ethers";

export const V1_RECALL = Object.freeze({
  adapter: "0x96091d4477Fe37E79557276d63883bBbbdE73159",
  wrapper: "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc",
  poolLane: "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f",
  token: "0x0000053900000000000000000000000001200000",
  owner: "0x01E6eed856e989201F4FF6346E18EAb7e46C874C",
  settler: "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
  convertedAccountId32: "0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3",
  convertedH160: "0x48DF881b65E682f05ac24DC8f668A8938225E973",
  aUsdc: "0x2ec4884088d84e5c2970a034732e5209b0acfa93",
  strategyId: "0x485944524154494f4e5f555344435f5631000000000000000000000000000000",
  recordedBookRaw: 10_000_001n,
  allSharesRaw: 10_000_001n,
  maxBookDriftRaw: 20_000n,
  maxFeePerLegRaw: 40_000n,
  hydrationChainId: 222_222,
  hydrationEvmRpc: "https://rpc.hydradx.cloud/",
  hydrationSubstrateRpc: "wss://hydration-rpc.n.dwellir.com",
  assetHubSubstrateRpc: "wss://polkadot-asset-hub-rpc.polkadot.io",
  reviveRefTime: 4_000_000_000n,
  reviveProofSize: 100_000n,
  storageDepositLimit: 1_000_000_000n,
});

export const ZERO32 = `0x${"00".repeat(32)}`;

const STAGE_ABI = Object.freeze([
  "function stageTreasuryWithdraw(address treasuryContext,uint256 shares,uint256 minimumAssets,uint256 remoteFeeBudget,uint64 dispatchDeadline,uint64 nonce) returns (bytes32)",
]);
const TOKEN_ABI = Object.freeze([
  "function transfer(address recipient,uint256 amount) returns (bool)",
]);

export function deriveTreasuryContext({
  depositEvidence,
  adapterRequest,
  wrapperRequest,
  currentTotalShares,
  expectedWrapper = V1_RECALL.wrapper,
  expectedAdapter = V1_RECALL.adapter,
}) {
  const data = depositEvidence?.event?.data;
  const requestId = normalizeBytes32(data?.requestId, "deposit evidence requestId");
  if (
    depositEvidence?.kind !== "averray.bankV22DepositDispatchBackfill"
    || data?.leg !== "deposit_sell"
    || Number(data?.legIndex) !== 1
    || getAddress(data?.wrapper) !== getAddress(expectedWrapper)
    || String(data?.remoteExecution?.event?.data?.fillerType).toUpperCase() !== "AAVE"
    || Number(data?.remoteExecution?.event?.data?.assetIn) !== 22
    || Number(data?.remoteExecution?.event?.data?.assetOut) !== 1003
  ) {
    throw new Error("Treasury context requires the immutable, request-bound v1 deposit event evidence.");
  }

  const adapter = normalizeAdapterRequest(adapterRequest);
  const wrapper = normalizeWrapperRequest(wrapperRequest);
  const shares = BigInt(currentTotalShares);
  if (
    adapter.kind !== 0
    || adapter.status !== 2
    || adapter.settled !== true
    || adapter.settledShares !== shares
    || shares !== V1_RECALL.allSharesRaw
  ) {
    throw new Error("Deposit evidence does not reproduce the live adapter's settled v1 share book.");
  }
  const treasuryContext = getAddress(adapter.account);
  if (
    treasuryContext !== getAddress(adapter.requester)
    || treasuryContext !== getAddress(adapter.recipient)
    || wrapper.kind !== 0
    || wrapper.status !== 2
    || wrapper.account !== treasuryContext
    || wrapper.recipient !== treasuryContext
    || wrapper.queuedBy !== getAddress(expectedAdapter)
    || wrapper.strategyId !== V1_RECALL.strategyId
    || wrapper.assets !== adapter.requestedAssets
    || wrapper.settledAssets !== adapter.settledAssets
    || wrapper.settledShares !== adapter.settledShares
  ) {
    throw new Error("Adapter and wrapper deposit state do not derive one unambiguous treasury context.");
  }
  return {
    source: "immutable deposit event + live adapter.getAdapterRequest + live wrapper.getRequest",
    requestId,
    treasuryContext,
    requestedAssetsRaw: adapter.requestedAssets,
    settledAssetsRaw: adapter.settledAssets,
    settledSharesRaw: adapter.settledShares,
  };
}

export function buildStageTreasuryWithdrawCall({
  treasuryContext,
  shares = V1_RECALL.allSharesRaw,
  minimumAssets = V1_RECALL.recordedBookRaw,
  remoteFeeBudget = V1_RECALL.maxFeePerLegRaw,
  dispatchDeadline,
  nonce,
}) {
  if (!treasuryContext) throw new Error("Refusing Leg A without a treasuryContext derived from deposit evidence and live state.");
  const amount = positiveBigInt(shares, "shares");
  const minimum = positiveBigInt(minimumAssets, "minimumAssets");
  const maximumFee = positiveBigInt(remoteFeeBudget, "remoteFeeBudget");
  const deadline = positiveBigInt(dispatchDeadline, "dispatchDeadline");
  const requestNonce = positiveBigInt(nonce, "nonce");
  if (amount !== V1_RECALL.allSharesRaw) throw new Error(`Leg A must recall all ${V1_RECALL.allSharesRaw} v1 shares.`);
  if (minimum !== V1_RECALL.recordedBookRaw) throw new Error("Leg A minimumAssets must equal the recorded v1 principal book.");
  if (maximumFee > V1_RECALL.maxFeePerLegRaw) throw new Error("Leg A remote fee budget exceeds the reviewed 40,000-raw ceiling.");
  if (deadline > ((1n << 64n) - 1n) || requestNonce > ((1n << 64n) - 1n)) throw new Error("deadline and nonce must fit uint64.");
  const context = getAddress(treasuryContext);
  const iface = new Interface(STAGE_ABI);
  const data = iface.encodeFunctionData("stageTreasuryWithdraw", [
    context,
    amount,
    minimum,
    maximumFee,
    deadline,
    requestNonce,
  ]);
  const decoded = iface.decodeFunctionData("stageTreasuryWithdraw", data);
  if (
    getAddress(decoded.treasuryContext) !== context
    || BigInt(decoded.shares) !== amount
    || BigInt(decoded.minimumAssets) !== minimum
    || BigInt(decoded.remoteFeeBudget) !== maximumFee
    || BigInt(decoded.dispatchDeadline) !== deadline
    || BigInt(decoded.nonce) !== requestNonce
  ) throw new Error("Leg A calldata failed its encode/decode self-check.");
  return {
    label: "HydrationUsdcAdapterV22.stageTreasuryWithdraw(all v1 shares)",
    to: V1_RECALL.adapter,
    data,
    decoded: {
      treasuryContext: context,
      shares: amount,
      minimumAssets: minimum,
      remoteFeeBudget: maximumFee,
      dispatchDeadline: deadline,
      nonce: requestNonce,
    },
  };
}

export function deriveWithdrawRequestId({ treasuryContext, nonce }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [
      V1_RECALL.strategyId,
      1,
      getAddress(treasuryContext),
      V1_RECALL.token,
      V1_RECALL.owner,
      0n,
      V1_RECALL.allSharesRaw,
      positiveBigInt(nonce, "nonce"),
    ],
  ));
}

export function assertUnusedWithdrawCandidate(record) {
  const wrapper = normalizeWrapperRequest(record);
  if (wrapper.status !== 0 || wrapper.account !== ZeroAddress) {
    throw new Error("Derived withdraw requestId is already occupied; choose a fresh nonce and rebuild.");
  }
  return true;
}

export function assertBookPreflight({ totalAssets, totalShares, pendingWithdrawalShares, expectedPendingWithdrawalShares = 0n }) {
  const assets = BigInt(totalAssets);
  const shares = BigInt(totalShares);
  const drift = assets >= V1_RECALL.recordedBookRaw
    ? assets - V1_RECALL.recordedBookRaw
    : V1_RECALL.recordedBookRaw - assets;
  if (shares !== V1_RECALL.allSharesRaw) throw new Error(`Live v1 shares are ${shares}; expected all ${V1_RECALL.allSharesRaw}.`);
  if (drift > V1_RECALL.maxBookDriftRaw) throw new Error(`Live v1 book drift ${drift} exceeds the reviewed accrual tolerance.`);
  if (BigInt(pendingWithdrawalShares) !== BigInt(expectedPendingWithdrawalShares)) {
    throw new Error(`Live pending v1 withdrawal is ${pendingWithdrawalShares}; expected ${expectedPendingWithdrawalShares}.`);
  }
  return { totalAssetsRaw: assets, totalSharesRaw: shares, bookDriftRaw: drift };
}

export function assertPoolLaneUntouched(opening, current, phase = "recall") {
  const fields = ["totalAssetsRaw", "totalSharesRaw", "pendingWithdrawalSharesRaw"];
  for (const field of fields) {
    if (BigInt(opening?.[field] ?? -1) !== BigInt(current?.[field] ?? -2)) {
      throw new Error(`INCIDENT: pool lane ${field} moved during ${phase}; stop the ceremony.`);
    }
  }
  return true;
}

export function deriveLegCTransfer({ evidence, currentMultisigBalance }) {
  if (evidence?.kind !== "averray.v1LaneRecallEvidence" || evidence?.phase !== "completed") {
    throw new Error("Leg C requires completed Leg B evidence.");
  }
  const opening = BigInt(evidence?.opening?.multisigUsdcRaw ?? -1);
  const expected = BigInt(evidence?.settlement?.homeArrivalRaw ?? -1);
  const current = BigInt(currentMultisigBalance);
  if (opening < 0n || expected <= 0n) throw new Error("Leg B evidence omits the opening multisig balance or expected proceeds.");
  if (current < expected) {
    throw new Error(`Leg C refuses: multisig USDC balance ${current} is below expected proceeds ${expected}.`);
  }
  const arrived = current - opening;
  if (arrived !== expected) {
    throw new Error(`Leg C cannot isolate the XCM arrival: live delta ${arrived} differs from expected proceeds ${expected}.`);
  }
  return { openingRaw: opening, currentRaw: current, expectedProceedsRaw: expected, arrivedRaw: arrived };
}

export function buildLegCTransferCall({ recipient = V1_RECALL.settler, amount }) {
  const value = positiveBigInt(amount, "Leg C transfer amount");
  const iface = new Interface(TOKEN_ABI);
  const data = iface.encodeFunctionData("transfer", [getAddress(recipient), value]);
  const decoded = iface.decodeFunctionData("transfer", data);
  if (getAddress(decoded.recipient) !== getAddress(recipient) || BigInt(decoded.amount) !== value) {
    throw new Error("Leg C calldata failed its encode/decode self-check.");
  }
  return {
    label: "USDC.transfer(KMS signer, exact observed v1 proceeds)",
    to: V1_RECALL.token,
    data,
    decoded: { recipient: getAddress(recipient), amount: value },
  };
}

export function buildReviveCallPayload({ api, call, blake2AsHex }) {
  const revive = api.tx.revive.call(
    call.to,
    0n,
    { refTime: V1_RECALL.reviveRefTime, proofSize: V1_RECALL.reviveProofSize },
    V1_RECALL.storageDepositLimit,
    call.data,
  );
  const scale = revive.method.toHex();
  const callHash = blake2AsHex(revive.method.toU8a(), 256);
  assertCallHashShape({ scale, callHash });
  if (!scale.toLowerCase().includes(call.data.slice(2).toLowerCase())) {
    throw new Error("Nova SCALE output does not embed the reviewed EVM calldata.");
  }
  return { scale, callHash };
}

export function assertCallHashShape({ scale, callHash }) {
  if (!/^0x[0-9a-f]+$/iu.test(String(scale)) || String(scale).length < 6) {
    throw new Error("Nova call SCALE must be non-empty 0x-prefixed hex.");
  }
  if (!/^0x[0-9a-f]{64}$/iu.test(String(callHash))) {
    throw new Error("Nova countersign call hash must be a 32-byte blake2 hash.");
  }
  return true;
}

export function stringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
}

export function normalizeBytes32(value, label = "bytes32") {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) throw new Error(`${label} must be 0x-prefixed bytes32.`);
  return normalized;
}

export function positiveBigInt(value, label) {
  if (!/^[0-9]+$/u.test(String(value ?? ""))) throw new Error(`${label} must be an unsigned integer.`);
  const result = BigInt(value);
  if (result <= 0n) throw new Error(`${label} must be positive.`);
  return result;
}

function normalizeAdapterRequest(record) {
  return {
    kind: Number(record?.kind ?? record?.[0] ?? -1),
    status: Number(record?.status ?? record?.[1] ?? -1),
    account: record?.account ?? record?.[2],
    requester: record?.requester ?? record?.[3],
    recipient: record?.recipient ?? record?.[4],
    requestedAssets: BigInt(record?.requestedAssets ?? record?.[5] ?? -1),
    settledAssets: BigInt(record?.settledAssets ?? record?.[7] ?? -1),
    settledShares: BigInt(record?.settledShares ?? record?.[8] ?? -1),
    settled: record?.settled ?? record?.[11] ?? record?.[12] ?? false,
  };
}

function normalizeWrapperRequest(record) {
  const context = record?.context ?? record?.[0] ?? {};
  const account = context?.account ?? context?.[2] ?? ZeroAddress;
  const recipient = context?.recipient ?? context?.[4] ?? ZeroAddress;
  return {
    strategyId: String(context?.strategyId ?? context?.[0] ?? ZERO32).toLowerCase(),
    kind: Number(context?.kind ?? context?.[1] ?? -1),
    account: getAddress(account),
    recipient: getAddress(recipient),
    assets: BigInt(context?.assets ?? context?.[5] ?? 0),
    queuedBy: getAddress(record?.queuedBy ?? record?.[1] ?? ZeroAddress),
    status: Number(record?.status ?? record?.[2] ?? 0),
    settledAssets: BigInt(record?.settledAssets ?? record?.[3] ?? 0),
    settledShares: BigInt(record?.settledShares ?? record?.[4] ?? 0),
  };
}
