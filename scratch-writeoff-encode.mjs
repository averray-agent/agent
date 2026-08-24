// Read-only Nova packet builder: DepositPool.writeOffVenueLoss(2, <outstanding>)
// Authority: 2-of-3 treasury owner multisig (= venueAdapter.lossReporter()).
// Measured-weight law: reviveApi.call gasRequired, +25% headroom, never pinned.
import { Interface, getAddress, JsonRpcProvider, Contract } from "ethers";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { blake2AsHex, decodeAddress } from "@polkadot/util-crypto";

const POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const MULTISIG = "0x01E6eed856e989201F4FF6346E18EAb7e46C874C";
const DEPLOYMENT_ID = 2n;

const provider = new JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/", 420420419);
const pool = new Contract(POOL, [
  "function venueDeployments(uint256) view returns (uint256 principalAssets, uint256 recalledPrincipalAssets, uint64 returnBy, bytes32 adapterRequestId, uint8 status)",
  "function venueWrittenOffPrincipalAssets(uint256) view returns (uint256)",
  "function activeVenueDeploymentId() view returns (uint256)",
  "function venuePrincipalCostBasis() view returns (uint256)"
], provider);

const [dep, written, activeId, costBasis] = await Promise.all([
  pool.venueDeployments(DEPLOYMENT_ID), pool.venueWrittenOffPrincipalAssets(DEPLOYMENT_ID),
  pool.activeVenueDeploymentId(), pool.venuePrincipalCostBasis()
]);
const outstanding = dep.principalAssets - dep.recalledPrincipalAssets - written;
console.log("deployment 2: principal", dep.principalAssets.toString(), "recalled", dep.recalledPrincipalAssets.toString(), "writtenOff", written.toString());
console.log("outstanding to write off:", outstanding.toString(), "raw =", Number(outstanding) / 1e6, "USDC");
console.log("activeVenueDeploymentId:", activeId.toString(), "| venuePrincipalCostBasis:", costBasis.toString());
if (outstanding <= 0n) throw new Error("nothing outstanding — already closed");

const iface = new Interface(["function writeOffVenueLoss(uint256,uint256)"]);
const data = iface.encodeFunctionData("writeOffVenueLoss", [DEPLOYMENT_ID, outstanding]);
const dec = iface.decodeFunctionData("writeOffVenueLoss", data);
if (dec[0] !== DEPLOYMENT_ID || dec[1] !== outstanding) throw new Error("encode/decode self-check failed");

// EVM preflight as the multisig
await provider.call({ from: MULTISIG, to: POOL, data });
console.log("evm preflight from multisig: success");

// Substrate: measure real weight, then build revive.call with measured x1.25
const api = await ApiPromise.create({ provider: new WsProvider("wss://asset-hub-polkadot-rpc.n.dwellir.com", 5000), noInitWarn: true });
// True multisig AccountId32 from revive.originalAccount (native account, NOT 0xEE-mapped)
const origin = decodeAddress("14LA8vJD8JeQYMRd5yhiw3hxD7CK5txhfL9GSNPjzLRKc3YK");
const sim = await api.call.reviveApi.call(origin, POOL, 0, null, 1_000_000_000n, data);
console.log("sim keys:", Object.keys(sim.toJSON ? sim.toJSON() : sim));
const j = sim.toJSON ? sim.toJSON() : sim;
const g = j.weightRequired;
if (!g) { console.log("full sim:", JSON.stringify(j).slice(0, 400)); throw new Error("no gasRequired field"); }
const gr = { refTime: BigInt(g.refTime ?? g.ref_time), proofSize: BigInt(g.proofSize ?? g.proof_size) };
console.log("measured gasRequired: refTime", gr.refTime.toString(), "proofSize", gr.proofSize.toString());
const resOk = sim.result?.isOk ?? (j.result && j.result.ok !== undefined);
if (!resOk) throw new Error("reviveApi simulation reverted: " + JSON.stringify(j.result));
const refTime = (gr.refTime * 125n) / 100n;
const proofSize = (gr.proofSize * 125n) / 100n;
console.log("with 25% headroom: refTime", refTime.toString(), "proofSize", proofSize.toString());

const revive = api.tx.revive.call(POOL, 0n, { refTime, proofSize }, 1_000_000_000n, data);
const scale = revive.method.toHex();
const callHash = blake2AsHex(revive.method.toU8a(), 256);
if (!scale.toLowerCase().includes(data.slice(2).toLowerCase())) throw new Error("SCALE does not embed calldata");
console.log("\n=== NOVA PACKET — writeOffVenueLoss(2, " + outstanding.toString() + ") ===");
console.log("Call data (paste into Nova):");
console.log(scale);
console.log("\nblake2 call hash (Nova MUST display exactly this before Vault countersigns):");
console.log(callHash);
await api.disconnect();
