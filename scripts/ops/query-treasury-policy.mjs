#!/usr/bin/env node
// Quick read-only probe of TreasuryPolicy state. Cutover support script.
import { JsonRpcProvider, Contract } from "ethers";

const RPC = process.env.RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const POLICY = "0xE0b8170137f03F90d681451a97C68A9EAf85e4A7";
const ABI = [
  "function owner() view returns (address)",
  "function pauser() view returns (address)",
  "function verifiers(address) view returns (bool)",
  // Post-#724 the single `serviceOperators` role was split into five
  // capability roles. A signer cutover needs verifier + settlementBroker
  // (EscrowCore.claimJobFor) + agentTransferBroker (sendToAgentFor).
  "function settlementBroker(address) view returns (bool)",
  "function agentTransferBroker(address) view returns (bool)",
  "function paused() view returns (bool)",
];

const NEW_VERIFIER = "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F";

const provider = new JsonRpcProvider(RPC);
const policy = new Contract(POLICY, ABI, provider);

console.log(`Probing TreasuryPolicy at ${POLICY}`);
console.log(`RPC: ${RPC}\n`);

const [owner, pauser, paused, newApproved, newSettlementBroker, newAgentTransferBroker] =
  await Promise.all([
    policy.owner(),
    policy.pauser(),
    policy.paused(),
    policy.verifiers(NEW_VERIFIER),
    policy.settlementBroker(NEW_VERIFIER),
    policy.agentTransferBroker(NEW_VERIFIER),
  ]);

console.log("Owner:           ", owner);
console.log("Pauser:          ", pauser);
console.log("Paused:          ", paused);
console.log("");
console.log(`Signer roles for ${NEW_VERIFIER} (false = needs approval; true = already approved):`);
console.log(`  verifiers:            ${newApproved}`);
console.log(`  settlementBroker:     ${newSettlementBroker}`);
console.log(`  agentTransferBroker:  ${newAgentTransferBroker}`);
