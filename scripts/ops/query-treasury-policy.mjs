#!/usr/bin/env node
// Quick read-only probe of TreasuryPolicy state. Cutover support script.
import { JsonRpcProvider, Contract } from "ethers";

const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const POLICY = "0x648Cc5fdE94435992296C4e5ac642d18bB64c12B";
const ABI = [
  "function owner() view returns (address)",
  "function pauser() view returns (address)",
  "function verifiers(address) view returns (bool)",
  "function serviceOperators(address) view returns (bool)",
  "function paused() view returns (bool)",
];

const NEW_VERIFIER = "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F";

const provider = new JsonRpcProvider(RPC);
const policy = new Contract(POLICY, ABI, provider);

console.log(`Probing TreasuryPolicy at ${POLICY}`);
console.log(`RPC: ${RPC}\n`);

const [owner, pauser, paused, newApproved] = await Promise.all([
  policy.owner(),
  policy.pauser(),
  policy.paused(),
  policy.verifiers(NEW_VERIFIER),
]);

console.log("Owner:           ", owner);
console.log("Pauser:          ", pauser);
console.log("Paused:          ", paused);
console.log("");
console.log(`verifiers(${NEW_VERIFIER}):`);
console.log(`  → ${newApproved}  (false = needs approval; true = already approved)`);
