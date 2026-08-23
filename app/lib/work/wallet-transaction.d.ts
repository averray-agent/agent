export interface WalletTransaction {
  from: string;
  to: string;
  data: string;
  value: "0x0";
}

export declare function withdrawalTransactionFromIntent(intent: unknown, wallet?: string): WalletTransaction | null;
