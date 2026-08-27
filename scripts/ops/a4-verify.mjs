#!/usr/bin/env node
/**
 * Ceremony A step A4 — pre- and post-signing verification (read-only).
 *
 *   node scripts/ops/a4-verify.mjs pre    # run BEFORE the Nova session
 *   node scripts/ops/a4-verify.mjs post   # run AFTER call 4 executes
 *
 * pre: all four target states must be UNSET (runsheet-already-ran law),
 *      postage non-zero on both A3 accounts, and the four call hashes must
 *      REPRODUCE exactly (any drift => stop, do not sign).
 * post: all four states set; adapter usable end to end via eth_call probes.
 */
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";

const POLICY = "0x226F14252A98BD2eA140271647De20132F09AF20";
const REGISTRY = "0x38af424415c1CE033e5Cee01f94551CDb824D404";
const POOL21 = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
const ADAPTER = "0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5";
const SID = "0x4141435f49444c455f4445504f5349545f504f4f4c5f56323100000000000000";
const EXPECTED = [
  "0x28d620db749d43fa686b8c369ce331a2e592636e2f29c9816409c60d01912927",
  "0x596b319f3b0f1fe4cf86da09834e5caf4c7890863abcb44b7d3a2c22a1f550e1",
  "0x9ddc7a2f65be9cf2b6f8c106dbb859e043082992f1bfad668bfb42e3e6076a6a",
  "0xc01e74ead8f55502cd193200813ec1954282c5ac74f1433b1b0ed92fb92ccd96",
];
const POSTAGE = [
  ["AAC", "0xb1350932bf85e7ffd0599e9a3cc7b55718d89e57eeeeeeeeeeeeeeeeeeeeeeee"],
  ["adapter", "0x1ddca7097c752580c6561e1bf8c673d6c1665ca5eeeeeeeeeeeeeeeeeeeeeeee"],
];

const mode = process.argv[2];
if (!["pre", "post"].includes(mode)) { console.error("usage: a4-verify.mjs pre|post"); process.exit(2); }
const c = createPublicClient({ transport: http("https://services.polkadothub-rpc.com/mainnet/") });
let ok = true;
const check = (label, cond, detail = "") => { console.log(`  ${cond ? "OK  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`); if (!cond) ok = false; };

const [approved, regAdapter, regActive, agg] = await Promise.all([
  c.readContract({ address: POLICY, abi: parseAbi(["function approvedStrategies(address) view returns (bool)"]), functionName: "approvedStrategies", args: [ADAPTER] }),
  c.readContract({ address: REGISTRY, abi: parseAbi(["function strategies(bytes32) view returns (bytes32 strategyId,address adapter,address asset,string riskLabel,bool active)"]), functionName: "strategies", args: [SID] }),
  null, null,
]).then(async ([a, s]) => [a, s[1], s[4], await c.readContract({ address: POOL21, abi: parseAbi(["function aggregatorAdapters(address) view returns (bool)"]), functionName: "aggregatorAdapters", args: [ADAPTER] })]);

console.log(`A4 ${mode}-verification @ ${new Date().toISOString()}`);
if (mode === "pre") {
  check("policy.approvedStrategies UNSET", approved === false);
  check("registry entry UNSET", regAdapter === "0x0000000000000000000000000000000000000000");
  check("pool aggregator flag UNSET", agg === false);
  const api = await ApiPromise.create({ provider: new WsProvider("wss://asset-hub-polkadot-rpc.n.dwellir.com"), noInitWarn: true });
  for (const [l, acct] of POSTAGE) {
    const a = (await api.query.system.account(acct)).toJSON();
    check(`postage ${l} non-zero`, BigInt(a.data.free) >= 100_000_000n, `${Number(BigInt(a.data.free)) / 1e10} DOT`);
  }
  const calls = [
    [POLICY, encodeFunctionData({ abi: parseAbi(["function setApprovedStrategy(address,bool)"]), functionName: "setApprovedStrategy", args: [ADAPTER, true] })],
    [REGISTRY, encodeFunctionData({ abi: parseAbi(["function registerStrategy(address)"]), functionName: "registerStrategy", args: [ADAPTER] })],
    [REGISTRY, encodeFunctionData({ abi: parseAbi(["function setStrategyActive(bytes32,bool)"]), functionName: "setStrategyActive", args: [SID, true] })],
    [POOL21, encodeFunctionData({ abi: parseAbi(["function setAggregatorAdapter(address,bool)"]), functionName: "setAggregatorAdapter", args: [ADAPTER, true] })],
  ];
  const gas = { refTime: 4_000_000_000, proofSize: 600_000 };
  calls.forEach(([to, data], i) => {
    const call = api.tx.revive.call(to, 0, gas, 1_000_000_000, data);
    const h = blake2AsHex(call.method.toU8a());
    check(`hash ${i + 1} reproduces`, h === EXPECTED[i], h);
  });
  await api.disconnect();
} else {
  check("policy.approvedStrategies SET", approved === true);
  check("registry adapter matches", regAdapter.toLowerCase() === ADAPTER.toLowerCase());
  check("registry ACTIVE", regActive === true);
  check("pool aggregator flag SET", agg === true);
  try { await c.call({ to: ADAPTER, data: encodeFunctionData({ abi: parseAbi(["function pendingDepositAssets() view returns (uint256)"]), functionName: "pendingDepositAssets" }) }); check("async probe still reverts", false); }
  catch { check("async probe still reverts (SYNC classification)", true); }
}
console.log(ok ? `\n${mode.toUpperCase()}-VERIFY: ALL CLEAR` : `\n${mode.toUpperCase()}-VERIFY: FAILURES — STOP`);
process.exit(ok ? 0 : 1);
