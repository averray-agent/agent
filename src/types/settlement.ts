// Copyright 2024 Averray Agent
import { u128 } from '@polkadot/types-codec';

/** Supported settlement options */
export enum SettlementOption {
  USDC = 'USDC',
  XNO = 'XNO',
}

export interface SettlementParams {
  option: SettlementOption;
  amount: u128;
  nanoAddress?: string; // Only for XNO
}