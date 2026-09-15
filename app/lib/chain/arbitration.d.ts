import type { Eip1193Provider } from "../auth/wallet-provider.js";
export interface PreparedArbitration {
  to: string; data: string; value?: string; chainId: number; arbitrator: string;
  preparationId: string; preparedAt: string; remainingPayout: number; workerPayout: number; asset: string;
  decoded: { jobId: string; workerPayout: string; reasonCode: string; metadataURI: string };
}
export interface LiveArbitration { state: number | null; escrow?: string; remainingPayoutRaw: string; preparationId?: string; arbitrator: string; chainId: number }
export function arbitrationSigningState(input: { prepared?: PreparedArbitration | null; live?: LiveArbitration | null; account?: string | null; chainId?: number | string | null }): { allowed: boolean; reason: string };
export function sendPreparedArbitration(input: { prepared: PreparedArbitration; provider: Eip1193Provider; getLive(): Promise<LiveArbitration>; sendTransaction(tx: Record<string, unknown>): Promise<unknown> }): Promise<unknown>;
export function arbitrationWalletOptions(available: boolean): { injected: boolean; walletConnect: boolean; notice: string };
