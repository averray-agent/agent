// Copyright 2024 Averray Agent
import { NanoNode } from './node';

/** Thin Nano client wrapper for feeless XNO transfers */
export class NanoClient {
  private node: NanoNode;

  constructor() {
    this.node = new NanoNode('https://nano.org/api');
  }

  /** Sends XNO with deterministic finality */
  async sendXNO(params: {
    destination: string;
    amount: string; // Raw units (10^30)
  }): Promise<string> {
    return this.node.send({
      ...params,
      source: this._getDefaultSource(),
    });
  }

  private _getDefaultSource(): string {
    // In production: derive from Averray's Nano account
    return 'nano_3t6k3...'; // Placeholder - replace with actual source
  }
}