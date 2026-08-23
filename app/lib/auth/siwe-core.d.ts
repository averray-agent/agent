import type { AuthSession } from "./token-store";
import type { Eip1193Provider } from "./wallet-provider";

export interface PreparedSiwe {
  provider: Eip1193Provider;
  wallet: string;
  message: string;
}

export declare function prepareSiwe(input: {
  provider: Eip1193Provider;
  fetcher: typeof fetch;
  nonceUrl: string;
}): Promise<PreparedSiwe>;

export declare function completeSiwe(input: {
  prepared: PreparedSiwe;
  fetcher: typeof fetch;
  verifyUrl: string;
}): Promise<AuthSession>;
