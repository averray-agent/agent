// Protocol revenue — pure helpers for the admin-only revenue view.
//
// Reads the PROTOCOL TREASURY's AgentAccountCore position straight from the
// chain (browser eth_call; both public RPCs serve CORS *). This is where the
// 5% protocol fee accrues — a DIFFERENT account from any operator/agent wallet:
// the 2-of-3 owner multisig. The data is public on-chain; the admin gate is UI
// deference (revenue isn't every operator's business), not secrecy.
//
// Honesty contract (truth boundary): a failed/unreachable read renders
// "unreadable", NEVER a fake zero — on this page a zero is a real financial
// statement ("no fees earned"), so it must only come from a successful read on
// the right chain. Pure derivation, callers pass raw results.

export const PROTOCOL_TREASURY = "0x01E6eed856e989201F4FF6346E18EAb7e46C874C";
export const AGENT_ACCOUNT_CORE = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
export const USDC_ASSET = "0x0000053900000000000000000000000001200000";
export const EXPECTED_CHAIN_ID = 420420419; // Polkadot Hub mainnet
const USDC_DECIMALS = 6;

// keccak("positions(address,address)")[0..4] — the same selector our ops
// tooling uses against this exact deployed contract.
const POSITIONS_SELECTOR = "0x4bd21445";

export const RPC_ENDPOINTS = [
  "https://eth-rpc.polkadot.io/",
  "https://services.polkadothub-rpc.com/mainnet/",
] as const;

function pad32(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Calldata for AgentAccountCore.positions(treasury, USDC). */
export function positionsCalldata(
  account: string = PROTOCOL_TREASURY,
  asset: string = USDC_ASSET
): string {
  return `${POSITIONS_SELECTOR}${pad32(account)}${pad32(asset)}`;
}

export interface TreasuryPosition {
  /** All values in raw 6-dp USDC units. */
  liquid: bigint;
  reserved: bigint;
  strategyAllocated: bigint;
  collateralLocked: bigint;
  jobStakeLocked: bigint;
  debtOutstanding: bigint;
}

/** Decode the six uint256 words of a positions() result. Throws on malformed data. */
export function decodePositions(resultHex: string): TreasuryPosition {
  const hex = resultHex.replace(/^0x/, "");
  if (hex.length < 64 * 6) throw new Error(`positions() returned ${hex.length / 2} bytes; expected 192`);
  const word = (i: number) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`);
  return {
    liquid: word(0),
    reserved: word(1),
    strategyAllocated: word(2),
    collateralLocked: word(3),
    jobStakeLocked: word(4),
    debtOutstanding: word(5),
  };
}

export function formatUsdc(raw: bigint): string {
  const whole = raw / 10n ** BigInt(USDC_DECIMALS);
  const frac = (raw % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

export type RevenueView =
  | { kind: "loading" }
  | { kind: "wrong-chain"; got: number }
  | { kind: "unreadable"; detail: string }
  | { kind: "ready"; position: TreasuryPosition; endpoint: string; asOfMs: number };

/**
 * Fetch the treasury position with endpoint failover. Verifies the chain id
 * before trusting any balance — a healthy answer from the wrong chain is worse
 * than no answer.
 */
export async function fetchTreasuryPosition(
  fetchImpl: typeof fetch = fetch
): Promise<RevenueView> {
  let lastError = "no endpoint attempted";
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const call = async (method: string, params: unknown[]): Promise<string> => {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: string; error?: { message?: string } };
        if (body.error || typeof body.result !== "string") {
          throw new Error(body.error?.message ?? "malformed RPC response");
        }
        return body.result;
      };
      const chainId = Number.parseInt(await call("eth_chainId", []), 16);
      if (chainId !== EXPECTED_CHAIN_ID) return { kind: "wrong-chain", got: chainId };
      const raw = await call("eth_call", [
        { to: AGENT_ACCOUNT_CORE, data: positionsCalldata() },
        "latest",
      ]);
      return { kind: "ready", position: decodePositions(raw), endpoint, asOfMs: Date.now() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { kind: "unreadable", detail: lastError };
}
