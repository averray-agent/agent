import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { WalletChainRefusedError, type Eip1193Provider } from "@/lib/auth/wallet-provider.js";

/**
 * C2 funding rail. Trust shape mirrors scripts/ops/post-external-bounty.mjs:
 * the app NEVER constructs escrow calldata — it verifies the draft's own
 * calldata against the live /poster/onboarding addresses plus the poster's
 * form input, and the connected wallet signs. All amounts that matter are
 * re-read from the chain through the wallet's provider before anything is
 * sent.
 */

export const CREATE_SINGLE_PAYOUT_SIGNATURE =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)";

const ESCROW_ABI = parseAbi([
  `function ${CREATE_SINGLE_PAYOUT_SIGNATURE}`,
  "function protocolFeeBps() view returns (uint16)",
  "function previewProtocolFee(uint256 reward) view returns (uint256)",
]);
const AAC_ABI = parseAbi([
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
  "function deposit(address asset, uint256 amount)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Known public RPC endpoints for wallet_addEthereumChain (mainnet only). */
const MAINNET_ADD_CHAIN = {
  chainId: 420420419,
  chainName: "Polkadot Hub",
  nativeCurrency: { name: "DOT", symbol: "DOT", decimals: 18 },
  rpcUrls: [
    "https://services.polkadothub-rpc.com/mainnet/",
    "https://eth-rpc.polkadot.io/",
  ],
};

const BYTES32_RE = /^0x[0-9a-f]{64}$/iu;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/iu;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function sameAddress(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    ADDRESS_RE.test(a) &&
    a.toLowerCase() === b.toLowerCase()
  );
}

/** "1" / "2.5" → 6-decimal raw bigint; null when not an exact USDC amount. */
export function parseUsdcToRaw(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return whole * 1_000_000n + fraction;
}

export function formatRawUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export interface Gate {
  label: string;
  pass: boolean;
  detail: string;
}

export interface VerifiedDraftCall {
  gates: Gate[];
  allPass: boolean;
  to: Address | null;
  args: readonly [Hex, Address, bigint, bigint, bigint, bigint, Hex, Hex, Hex] | null;
  rewardRaw: bigint;
  opsReserveRaw: bigint;
  contingencyReserveRaw: bigint;
}

/**
 * Client-side replica of the ops script's calldata gates. `onboarding` is
 * the live /poster/onboarding payload — the addresses come from it, never
 * from constants.
 */
export function verifyDraftCalldata(
  draft: unknown,
  onboarding: unknown,
  expectedRewardRaw: bigint | null
): VerifiedDraftCall {
  const draftRecord = asRecord(draft);
  const calldata = asRecord(draftRecord.calldata);
  const onboardingRecord = asRecord(onboarding);
  const token = asRecord(onboardingRecord.token);
  const gates: Gate[] = [];
  const args = Array.isArray(calldata.args) ? calldata.args : [];

  const push = (label: string, pass: boolean, detail: string) =>
    gates.push({ label, pass, detail });

  push(
    "Non-waived function",
    calldata.function === CREATE_SINGLE_PAYOUT_SIGNATURE,
    String(calldata.function ?? "missing")
  );
  push("Nine arguments", args.length === 9, `${args.length} args`);
  push("Zero native value", String(calldata.value) === "0", String(calldata.value ?? "missing"));
  push(
    "Target = live EscrowCore",
    sameAddress(calldata.to, onboardingRecord.escrowCore),
    `${String(calldata.to ?? "?")} vs ${String(onboardingRecord.escrowCore ?? "?")}`
  );
  push(
    "Asset = live USDC",
    sameAddress(args[1], token.address),
    `${String(args[1] ?? "?")} vs ${String(token.address ?? "?")}`
  );
  push(
    "specHash matches draft",
    typeof args[8] === "string" &&
      typeof draftRecord.specHash === "string" &&
      BYTES32_RE.test(args[8]) &&
      args[8].toLowerCase() === draftRecord.specHash.toLowerCase(),
    String(draftRecord.specHash ?? "missing")
  );

  const rewardRaw = /^\d+$/u.test(String(args[2] ?? "")) ? BigInt(String(args[2])) : null;
  push(
    "Reward = your form amount",
    rewardRaw !== null && expectedRewardRaw !== null && rewardRaw === expectedRewardRaw,
    rewardRaw !== null && expectedRewardRaw !== null
      ? `${formatRawUsdc(rewardRaw)} vs ${formatRawUsdc(expectedRewardRaw)} USDC`
      : "unparseable"
  );

  const opsRaw = /^\d+$/u.test(String(args[3] ?? "")) ? BigInt(String(args[3])) : 0n;
  const contingencyRaw = /^\d+$/u.test(String(args[4] ?? "")) ? BigInt(String(args[4])) : 0n;
  const allPass = gates.every((gate) => gate.pass);

  return {
    gates,
    allPass,
    to: allPass ? (String(calldata.to) as Address) : null,
    args: allPass
      ? ([
          String(args[0]) as Hex,
          String(args[1]) as Address,
          rewardRaw as bigint,
          opsRaw,
          contingencyRaw,
          BigInt(String(args[5])),
          String(args[6]) as Hex,
          String(args[7]) as Hex,
          String(args[8]) as Hex,
        ] as const)
      : null,
    rewardRaw: rewardRaw ?? 0n,
    opsReserveRaw: opsRaw,
    contingencyReserveRaw: contingencyRaw,
  };
}

export interface FundingPlan {
  feeBps: number;
  feeRaw: bigint;
  posterReservedRaw: bigint;
  liquidRaw: bigint;
  depositRequiredRaw: bigint;
  walletUsdcRaw: bigint;
  allowanceRaw: bigint;
  needsApprove: boolean;
  needsDeposit: boolean;
  walletCovers: boolean;
}

function clients(provider: Eip1193Provider) {
  const transport = custom(provider as never);
  return {
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ transport }),
  };
}

/**
 * Live funding math through the wallet's own provider — the same reads the
 * ops script performs, with the same refusal when live fee math disagrees
 * with bps arithmetic.
 */
export async function buildFundingPlan(
  provider: Eip1193Provider,
  {
    escrowCore,
    agentAccountCore,
    tokenAddress,
    wallet,
    verified,
  }: {
    escrowCore: Address;
    agentAccountCore: Address;
    tokenAddress: Address;
    wallet: Address;
    verified: VerifiedDraftCall;
  }
): Promise<FundingPlan> {
  const { publicClient } = clients(provider);
  const [feeBps, previewFee, positions, walletUsdc, allowance] = await Promise.all([
    publicClient.readContract({ address: escrowCore, abi: ESCROW_ABI, functionName: "protocolFeeBps" }),
    publicClient.readContract({
      address: escrowCore,
      abi: ESCROW_ABI,
      functionName: "previewProtocolFee",
      args: [verified.rewardRaw],
    }),
    publicClient.readContract({
      address: agentAccountCore,
      abi: AAC_ABI,
      functionName: "positions",
      args: [wallet, tokenAddress],
    }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet, agentAccountCore],
    }),
  ]);

  const calculated = (verified.rewardRaw * BigInt(feeBps)) / 10_000n;
  if (previewFee !== calculated) {
    throw new Error(
      `Live previewProtocolFee (${previewFee}) disagrees with reward × ${feeBps} bps (${calculated}) — refusing unreconciled fee math.`
    );
  }

  const posterReservedRaw =
    verified.rewardRaw + previewFee + verified.opsReserveRaw + verified.contingencyReserveRaw;
  const liquidRaw = positions[0];
  const depositRequiredRaw = posterReservedRaw > liquidRaw ? posterReservedRaw - liquidRaw : 0n;

  return {
    feeBps: Number(feeBps),
    feeRaw: previewFee,
    posterReservedRaw,
    liquidRaw,
    depositRequiredRaw,
    walletUsdcRaw: walletUsdc,
    allowanceRaw: allowance,
    needsApprove: depositRequiredRaw > 0n && allowance < depositRequiredRaw,
    needsDeposit: depositRequiredRaw > 0n,
    walletCovers: walletUsdc >= depositRequiredRaw,
  };
}

/** Connect, verify the account matches the SIWE wallet, ensure the chain. */
export async function ensureWalletReady(
  provider: Eip1193Provider,
  { expectedWallet, chainId }: { expectedWallet: string; chainId: number }
): Promise<{ account: Address }> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = (accounts[0] ?? "").toLowerCase();
  if (account !== expectedWallet.toLowerCase()) {
    throw new Error(
      `Connected wallet ${account || "(none)"} is not the signed-in poster ${expectedWallet}. Switch accounts and retry.`
    );
  }
  const chainHex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 4902 && chainId === MAINNET_ADD_CHAIN.chainId) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{ ...MAINNET_ADD_CHAIN, chainId: chainHex }],
        });
      } catch {
        throw new WalletChainRefusedError();
      }
    } else {
      throw new WalletChainRefusedError();
    }
  }
  const current = parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
  if (current !== chainId) {
    throw new WalletChainRefusedError();
  }
  return { account: account as Address };
}

async function send(
  provider: Eip1193Provider,
  account: Address,
  to: Address,
  data: Hex
): Promise<Hex> {
  const { walletClient } = clients(provider);
  return walletClient.sendTransaction({
    account,
    to,
    data,
    value: 0n,
    chain: null,
  });
}

export async function sendApprove(
  provider: Eip1193Provider,
  account: Address,
  tokenAddress: Address,
  spender: Address,
  amount: bigint
): Promise<Hex> {
  return send(
    provider,
    account,
    tokenAddress,
    encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] })
  );
}

export async function sendDeposit(
  provider: Eip1193Provider,
  account: Address,
  agentAccountCore: Address,
  tokenAddress: Address,
  amount: bigint
): Promise<Hex> {
  return send(
    provider,
    account,
    agentAccountCore,
    encodeFunctionData({ abi: AAC_ABI, functionName: "deposit", args: [tokenAddress, amount] })
  );
}

/** The create call is the draft's own calldata — args pass through verbatim. */
export async function sendCreateJob(
  provider: Eip1193Provider,
  account: Address,
  verified: VerifiedDraftCall
): Promise<Hex> {
  if (!verified.allPass || !verified.to || !verified.args) {
    throw new Error("Refusing to send: draft calldata gates did not all pass.");
  }
  return send(
    provider,
    account,
    verified.to,
    encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "createSinglePayoutJob",
      args: verified.args,
    })
  );
}

export async function waitForReceipt(provider: Eip1193Provider, hash: Hex): Promise<boolean> {
  const { publicClient } = clients(provider);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return receipt.status === "success";
}
