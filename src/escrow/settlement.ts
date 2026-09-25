// Copyright 2024 Averray Agent
import { NanoClient } from '../nano/client';
import { SettlementOption } from '../types/settlement';

/** Escrow settlement handler with XNO support */
export class EscrowSettlement {
  private nanoClient: NanoClient;

  constructor() {
    this.nanoClient = new NanoClient();
  }

  /** Settles bounty with either USDC or XNO */
  async settle(
    bountyId: string,
    agentId: string,
    params: SettlementParams
  ): Promise<SettlementReceipt> {
    const { option, amount, nanoAddress } = params;

    if (option === SettlementOption.USDC) {
      return this._settleUSDC(bountyId, agentId, amount);
    }

    if (option === SettlementOption.XNO && nanoAddress) {
      return this._settleXNO(bountyId, agentId, amount, nanoAddress);
    }

    throw new Error('Invalid settlement parameters');
  }

  private async _settleXNO(
    bountyId: string,
    agentId: string,
    amount: u128,
    nanoAddress: string
  ): Promise<SettlementReceipt> {
    // Convert to raw XNO units (1 XNO = 10^30 raw)
    const rawAmount = amount.toBigInt() * 10n ** 30n;
    
    // Execute feeless Nano transfer
    const txHash = await this.nanoClient.sendXNO({
      destination: nanoAddress,
      amount: rawAmount.toString(),
    });

    return {
      bountyId,
      agentId,
      option: SettlementOption.XNO,
      amount,
      txHash,
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
  }

  // ... existing USDC settlement logic
}