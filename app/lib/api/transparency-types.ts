export type TransparencyFieldStatus = "fresh" | "stale" | "unknown";

export interface TransparencyField<T = string | number> {
  value: T | null;
  unit: string;
  status: TransparencyFieldStatus;
  readAtMs: number | null;
  source: string;
  proof: string;
}

export interface TransparencyPayload {
  schemaVersion: "averray.transparency.v1";
  generatedAtMs: number;
  readPolicy: {
    cacheTtl: TransparencyField<number>;
    freshnessWindows: {
      flow: TransparencyField<number>;
      chain: TransparencyField<number>;
      bank: TransparencyField<number>;
      subject: TransparencyField<number>;
    };
  };
  flow: {
    jobsSettled: {
      last24h: TransparencyField<number>;
      last7d: TransparencyField<number>;
      allTime: TransparencyField<number>;
    };
    usdcPaid: {
      last24h: TransparencyField<string>;
      last7d: TransparencyField<string>;
      allTime: TransparencyField<string>;
    };
    composition24h: {
      platformVerificationRuns: TransparencyField<number>;
      ingested: TransparencyField<number>;
      external: TransparencyField<number>;
      unclassified: TransparencyField<number>;
      total: TransparencyField<number>;
    };
  };
  escrow: {
    contractAddress: TransparencyField<string>;
    posterObligationsInFlight: TransparencyField<string>;
    balanceHeldByEscrowContract: TransparencyField<string>;
  };
  treasury: {
    generation: {
      wrapperAddress: TransparencyField<string>;
      version: TransparencyField<string>;
      state: TransparencyField<string>;
      reason: TransparencyField<string>;
    };
    totalUsdcEquivalent: TransparencyField<string>;
    lines: {
      assetHubMultisig: {
        balance: TransparencyField<string>;
        nativeAccountId32: TransparencyField<string>;
        evmLens: TransparencyField<string>;
      };
      hydrationPosition: {
        total: TransparencyField<string>;
        principal: TransparencyField<string>;
        accruedYield: TransparencyField<string>;
        note: TransparencyField<string>;
      };
      operatingFloat: {
        balance: TransparencyField<string>;
        asset: TransparencyField<string>;
      };
    };
  };
}
