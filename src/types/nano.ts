// Copyright 2024 Averray Agent
/** Nano-specific types */
export type NanoAddress = string;

export interface NanoTransfer {
  source: NanoAddress;
  destination: NanoAddress;
  amount: string; // Raw units (10^30)
  blockHash?: string;
}