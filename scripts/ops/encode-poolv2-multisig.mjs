// Encode the pool-v2 wrapper repoint as ONE utility.batchAll of 3 revive.calls,
// with the raised gas envelope (25e9/600k — the v3 ceremony OutOfGas lesson).
// Read-only; touches no keys. Usage:
//   node scripts/ops/encode-poolv2-multisig.mjs --lane 0xNEWLANE
import { ApiPromise, WsProvider } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";
import { Interface, encodeBytes32String, getAddress } from "ethers";

const WRAPPER = "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc";
const STRATEGY_ID = encodeBytes32String("HYDRATION_USDC_POOL_V1");
const GAS = { ref_time: 25_000_000_000n, proof_size: 600_000n };
const DEPOSIT = 1_000_000_000n;

const laneIndex = process.argv.indexOf("--lane");
if (laneIndex === -1) { console.error("usage: node scripts/ops/encode-poolv2-multisig.mjs --lane 0x…"); process.exit(1); }
const LANE = getAddress(process.argv[laneIndex + 1]);

const iface = new Interface([
  "function setDispatchPaused(bool)",
  "function setStrategyAdapter(bytes32,address)"
]);
const legs = [
  ["setDispatchPaused(true)", iface.encodeFunctionData("setDispatchPaused", [true])],
  [`setStrategyAdapter(HYDRATION_USDC_POOL_V1, ${LANE})`, iface.encodeFunctionData("setStrategyAdapter", [STRATEGY_ID, LANE])],
  ["setDispatchPaused(false)", iface.encodeFunctionData("setDispatchPaused", [false])]
];

const api = await ApiPromise.create({ provider: new WsProvider("wss://polkadot-asset-hub-rpc.polkadot.io"), noInitWarn: true });
const calls = legs.map(([label, data]) => {
  console.log(`leg: ${label}`);
  console.log(`  evm data: ${data}`);
  return api.tx.revive.call(WRAPPER, 0, GAS, DEPOSIT, data);
});
const batch = api.tx.utility.batchAll(calls);
const callHex = batch.method.toHex();
console.log(`\nutility.batchAll hex (paste as Nova Spektr call data):\n${callHex}`);
console.log(`\nblake2 call hash (verify on the Vault device):\n${blake2AsHex(batch.method.toU8a(), 256)}`);
await api.disconnect();
process.exit(0);
