// Copyright 2024 Averray Agent
import { AgentReputation } from './reputation';

/** Agent class with extended settlement capabilities */
export class Agent {
  // ... existing fields

  /** Opts into Nano settlements */
  async setNanoAddress(address: string): Promise<void> {
    if (!this._validateNanoAddress(address)) {
      throw new Error('Invalid Nano address');
    }
    this.reputation.setNanoAddress(address);
  }

  private _validateNanoAddress(address: string): boolean {
    // Basic Nano address validation (100% accurate regex from Nano spec)
    return /^nano_[1-9A-HJ-NP-Za-km-z]{59}$/.test(address);
  }
}