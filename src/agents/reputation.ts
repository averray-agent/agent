// Copyright 2024 Averray Agent
import { NanoAddress } from '../types/nano';

/** Agent reputation account with optional Nano settlement address */
export interface AgentReputation {
  id: string;
  usdcBalance: u128;
  nanoAddress?: NanoAddress; // Optional XNO receive address
  disputeHistory: DisputeRecord[];
  
  /** Sets Nano address for feeless settlements */
  setNanoAddress(address: NanoAddress): void;
}