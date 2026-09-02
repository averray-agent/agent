#!/usr/bin/env node
/**
 * Epoch-2 §B roll (memo E2-1..E2-5 as amended+ratified 2026-08-20):
 * recall deployment #2 fully (principal+yield) -> settle -> deploy 9.5 for +7d.
 *
 *   KMS_KEY_ID=... AWS_REGION=... node scratch-epoch2-roll.mjs --phase recall [--commit]
 *   node scratch-epoch2-roll.mjs --phase status          (read-only poll)
 *   node scratch-epoch2-roll.mjs --phase settle [--commit]   (permissionless)
 *   KMS... node scratch-epoch2-roll.mjs --phase deploy [--commit]
 *   node scratch-epoch2-roll.mjs --phase verify
 */
import { JsonRpcProvider, Contract, formatUnits } from "ethers";

import { KmsSigner } from "./mcp-server/src/blockchain/kms-signer.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (has(f) ? argv[argv.indexOf(f) + 1] : undefined);
const commit = has("--commit");
const phase = val("--phase");

const POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const DEPLOYMENT_ID = 2n;
const NEW_LEG_RAW = 9_500_000n;           // E2-1 as amended: one 9.5 leg
const RETURN_BY_SECONDS = 7n * 24n * 3600n - 600n; // +7d minus 10min safety
const deployments = { rpcUrl: "https://services.polkadothub-rpc.com/mainnet/" };
const provider = new JsonRpcProvider(deployments.rpcUrl, 420420419);

const POOL_ABI = [
  "function venueAdapter() view returns (address)",
  "function activeVenueDeploymentId() view returns (uint256)",
  "function activeVenueRecallId() view returns (uint256)",
  "function nextVenueRecallId() view returns (uint256)",
  "function venueDeployments(uint256) view returns (uint256 principalAssets, uint256 recalledPrincipalAssets, uint64 returnBy, bytes32 adapterRequestId, uint8 status)",
  "function venueRecalls(uint256) view returns (uint256 deploymentId, uint256 requestedAssets, uint256 returnedAssets, bytes32 adapterRequestId, uint8 status)",
  "function totalAssets() view returns (uint256)",
  "function bufferAssets() view returns (uint256)",
  "function bufferFloor() view returns (uint256)",
  "function maxDeployableAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function recallVenueDeployment(uint256,uint256) returns (uint256)",
  "function settleVenueRecall(uint256) returns (uint8,uint256)",
  "function settleVenueDeployment(uint256) returns (uint8,uint256)",
  "function deployToVenue(uint256,uint64) returns (uint256)"
];
const ADAPTER_ABI = [
  "function managedAssets(address) view returns (uint256)",
  "function getRequest(bytes32) view returns (tuple(uint8 kind, uint8 status, uint256 assets, uint256 settledAssets, uint64 deadline))"
];
const STATUS = ["Unknown", "Pending", "Succeeded", "Failed", "Cancelled"];
const fmt = (x) => formatUnits(x, 6);

async function kmsPool() {
  const keyId = String(process.env.KMS_KEY_ID ?? "").trim();
  const region = String(process.env.AWS_REGION ?? "").trim();
  if (!keyId || !region) throw new Error("KMS_KEY_ID and AWS_REGION required for this phase.");
  const kms = new KmsSigner({ keyId, region, provider });
  const addr = await kms.getAddress();
  if (addr.toLowerCase() !== "0x5a6836c6d4d293f6e5377e6c28054f4171915813") throw new Error("KMS signer is not the pool operator");
  return new Contract(POOL, POOL_ABI, kms);
}
const pool = new Contract(POOL, POOL_ABI, provider);
const adapterAddr = await pool.venueAdapter();
const adapter = new Contract(adapterAddr, ADAPTER_ABI, provider);

async function snapshot(label) {
  const [ta, buf, floor, sharePrice, managed, activeDep, activeRec] = await Promise.all([
    pool.totalAssets(), pool.bufferAssets(), pool.bufferFloor(),
    pool.convertToAssets(1_000_000n), adapter.managedAssets(POOL),
    pool.activeVenueDeploymentId(), pool.activeVenueRecallId()
  ]);
  console.log(`${label}: totalAssets=${fmt(ta)} idle=${fmt(buf)} floor=${fmt(floor)} sharePrice=${fmt(sharePrice)} venueManaged=${fmt(managed)} activeDep=${activeDep} activeRecall=${activeRec}`);
  return { ta, buf, floor, sharePrice, managed, activeDep, activeRec };
}

if (phase === "recall") {
  const s = await snapshot("before");
  if (s.activeDep !== DEPLOYMENT_ID) throw new Error(`active deployment is ${s.activeDep}, expected ${DEPLOYMENT_ID}`);
  if (s.activeRec !== 0n) throw new Error(`a recall is already active: ${s.activeRec}`);
  const requested = s.managed; // full roll: principal + observed yield
  console.log(`plan: recallVenueDeployment(${DEPLOYMENT_ID}, ${fmt(requested)}) — FULL recall incl. yield`);
  const recallId = await pool.nextVenueRecallId();
  console.log("predicted recallId:", recallId.toString());
  if (!commit) { console.log("\nDRY-RUN — gate, then --commit."); process.exit(0); }
  const signer = await kmsPool();
  const tx = await signer.recallVenueDeployment(DEPLOYMENT_ID, requested);
  console.log("tx:", tx.hash, "status:", (await tx.wait()).status);
  const rec = await pool.venueRecalls(recallId);
  console.log("recall staged:", recallId.toString(), "requested:", fmt(rec.requestedAssets), "adapterRequestId:", rec.adapterRequestId);
  console.log("NOW WAIT for the XCM round-trip (epoch-1: 45min–4h). Poll with --phase status.");
} else if (phase === "status") {
  const s = await snapshot("now");
  if (s.activeRec !== 0n) {
    const rec = await pool.venueRecalls(s.activeRec);
    const req = await adapter.getRequest(rec.adapterRequestId);
    console.log(`recall ${s.activeRec}: pool-status=${STATUS[Number(rec.status)]} adapter-request=${STATUS[Number(req.status)]} settledAssets=${fmt(req.settledAssets)}`);
    console.log(Number(req.status) >= 2 ? "TERMINAL — run --phase settle" : "still pending — keep waiting");
  } else {
    console.log("no active recall. If deployment slot is free, run --phase deploy.");
  }
} else if (phase === "settle") {
  const s = await snapshot("before");
  if (s.activeRec === 0n) throw new Error("no active recall to settle");
  const rec = await pool.venueRecalls(s.activeRec);
  const req = await adapter.getRequest(rec.adapterRequestId);
  console.log(`recall ${s.activeRec}: adapter-request=${STATUS[Number(req.status)]} settledAssets=${fmt(req.settledAssets)}`);
  if (Number(req.status) < 2) throw new Error("adapter request not terminal yet — wait");
  if (!commit) { console.log("\nDRY-RUN — gate, then --commit."); process.exit(0); }
  const signer = await kmsPool(); // permissionless, but sign with the KMS EOA for gas
  const tx = await signer.settleVenueRecall(s.activeRec);
  console.log("tx:", tx.hash, "status:", (await tx.wait()).status);
  await snapshot("after ");
} else if (phase === "deploy") {
  const s = await snapshot("before");
  if (s.activeDep !== 0n) throw new Error(`deployment slot still occupied by ${s.activeDep} — settle the recall first`);
  const max = await pool.maxDeployableAssets();
  console.log(`plan: deployToVenue(${fmt(NEW_LEG_RAW)}, now+7d)  · maxDeployable=${fmt(max)}`);
  if (NEW_LEG_RAW > max) throw new Error(`9.5 exceeds maxDeployable ${fmt(max)}`);
  if (!commit) { console.log("\nDRY-RUN — gate, then --commit."); process.exit(0); }
  const signer = await kmsPool();
  const block = await provider.getBlock("latest");
  const returnBy = BigInt(block.timestamp) + RETURN_BY_SECONDS;
  console.log("returnBy:", new Date(Number(returnBy) * 1000).toISOString());
  const before = await snapshot("pre   ");
  const tx = await signer.deployToVenue(NEW_LEG_RAW, returnBy);
  console.log("tx:", tx.hash, "status:", (await tx.wait()).status);
  const after = await snapshot("post  ");
  console.log("E2-4 checks:",
    "totalAssets unchanged:", after.ta === before.ta,
    "| idle -9.5:", after.buf === before.buf - NEW_LEG_RAW,
    "| sharePrice unchanged:", after.sharePrice === before.sharePrice);
} else if (phase === "settle-deploy") {
  const signer = await kmsPool();
  const before = await snapshot("before");
  if (!commit) { console.log("\nDRY-RUN — gate, then --commit."); process.exit(0); }
  const tx = await signer.settleVenueDeployment(3n);
  console.log("tx:", tx.hash, "status:", (await tx.wait()).status);
  await snapshot("after ");
  console.log("deployment 3 latched pool-side.");
} else if (phase === "verify") {
  const s = await snapshot("final");
  const dep = await pool.activeVenueDeploymentId();
  if (dep !== 0n) {
    const d = await pool.venueDeployments(dep);
    console.log(`deployment ${dep}: principal=${fmt(d.principalAssets)} returnBy=${new Date(Number(d.returnBy) * 1000).toISOString()} status=${STATUS[Number(d.status)]}`);
  }
  console.log("venue vs pool-books delta:", fmt(s.managed), "at venue for a", fmt(await pool.totalAssets() - await pool.bufferAssets()), "deployed book");
} else {
  throw new Error("--phase recall|status|settle|deploy|verify required");
}
