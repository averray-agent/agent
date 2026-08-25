// Read-only: quote the withdraw_sell remote fee for the staged recall request.
// Exit 0 the moment fee <= threshold (dispatch window open under the 40k cap).
import { JsonRpcProvider } from "ethers";
import { BankXcmV22Runtime } from "./mcp-server/src/services/bank-xcm-v22-runtime.js";
import { VenueBalanceReader } from "./mcp-server/src/services/venue-balance-reader.js";

const LANE_REQUEST = "0xe1029b108839059c6526077f8afbedd7e8c2130cabc29137d0260fa105e57ba3";
const THRESHOLD = 26_000n; // fee*1.5 must fit under the staged 40k cap; margin included
const once = process.argv.includes("--once");

const provider = new JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/", 420420419);
const convertedAccountId32 = "0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3";
const balanceReader = new VenueBalanceReader();
const targets = {
  float: { ledger: "substrate_tokens", endpoint: "wss://hydration-rpc.n.dwellir.com", account: convertedAccountId32, assetId: 22 },
  position: { ledger: "erc20", endpoint: "https://rpc.hydradx.cloud", chainId: 222222, account: convertedAccountId32, accountTransform: "hydration_truncate20", contract: "0x2ec4884088d84e5c2970a034732e5209b0acfa93" }
};
const runtime = new BankXcmV22Runtime({
  gateway: { hasXcmWrapper: () => true, provider, signer: { getAddress: async () => "0x5a6836c6D4d293F6E5377E6c28054F4171915813" }, config: { xcmWrapperAddress: "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc" } },
  balanceObserver: { async requireArmedWatch() { return {}; }, async getStatus() { return { enabled: true, running: true, chainEventWatchEnabled: true }; } },
  balanceReader,
  bankLaneFeed: { targets },
  adapterAddress: "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f",
  assetHubSubstrateEndpoint: "wss://asset-hub-polkadot-rpc.n.dwellir.com",
  hydrationSubstrateEndpoint: "wss://hydration-rpc.n.dwellir.com",
  logger: { warn() {}, error() {}, info() {}, log() {} }
});

for (;;) {
  try {
    const q = await runtime.quoteRemoteFee({ requestId: LANE_REQUEST, leg: 2 });
    const amt = BigInt(q.amount);
    const line = `${new Date().toISOString()} fee=${amt} (need <=${THRESHOLD} for the 40k cap) block=${q.blockNumber}`;
    console.log(line);
    if (amt <= THRESHOLD) { console.log("WINDOW OPEN — run the commit now"); process.exit(0); }
  } catch (e) {
    console.log(new Date().toISOString(), "quote error:", e.message?.slice(0, 100));
  }
  if (once) process.exit(0);
  await new Promise((r) => setTimeout(r, 60_000));
}
