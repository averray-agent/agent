import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import yaml from "js-yaml";
import { validateAllowList, returnSignerAsset, parseArgs, planHash, NATIVE_FLOOR, deploymentAddresses } from "./return-signer-asset.mjs";
const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("deployments/mainnet.json"));
const committed = JSON.parse(read("deployments/signer-asset-returns.mainnet.json"));
const destination = "0x1234567890123456789012345678901234567890";
function fixture() {
  const allowList = structuredClone(committed);
  allowList.returns[0].destination = destination;
  const sender = manifest.verifier.toLowerCase();
  const calls = { sends: [], signs: 0, reads: 0, logs: [] };
  const state = { balance: 13_000_000n, dest: 10n, native: NATIVE_FLOOR + 100n, cost: 100n, chain: 420420419n, symbol: "USDt", decimals: 6n, loss: 10000n, gain: 10000n, receipt: 1 };
  const args = { profile: "mainnet", useKms: true, expectedSigner: sender, key: "usdt-2026-11", amount: "10000" };
  const provider = {
    send: async (method) => method === "eth_chainId" ? state.chain : 1n,
    estimateGas: async (tx) => { assert.equal(tx.value, 0n); return state.cost; },
    getBalance: async () => state.native
  };
  const signer = {
    getAddress: async () => sender,
    sendTransaction: async (tx) => {
      calls.signs++;
      calls.sends.push(tx);
      state.balance -= state.loss;
      state.dest += state.gain;
      return { hash: "0xabc", wait: async () => ({ status: state.receipt, blockNumber: 123 }) };
    }
  };
  const token = {
    symbol: async () => state.symbol,
    decimals: async () => state.decimals,
    balanceOf: async (who) => { calls.reads++; return who === sender ? state.balance : state.dest; }
  };
  const f = { allowList, manifest, args, provider, signer, token, log: (line) => calls.logs.push(JSON.parse(line)), state, calls };
  f.run = () => returnSignerAsset(f);
  f.approve = async () => { const { hash, plan } = await f.run(); args.commit = true; args.expectedPlanHash = hash; args.confirm = `RETURN ${hash.slice(0, 12)}`; return plan; };
  return f;
}
async function refuses(f, pattern) {
  await assert.rejects(f.run, pattern);
  assert.equal(f.calls.signs, 0, "no KMS signing on refusal");
  assert.equal(f.calls.sends.length, 0);
}
test("committed destination is the operator-proven H160 and validates", () => {
  // Pascal supplied SS58 121pEreu…EYhyv on 2026-11-09; its revive H160 showed nonce 200 on chain.
  assert.equal(committed.returns[0].destination, "0xe30478EB20E5380849e96E0f1002821dacF339e5");
  assert.equal(validateAllowList(committed, manifest).entries[0].destination, "0xe30478eb20e5380849e96e0f1002821dacf339e5");
});
test("a placeholder destination refuses before any network/AWS", () => {
  const placeholder = structuredClone(committed);
  placeholder.returns[0].destination = "<PASCAL SUPPLIES — EVM H160>";
  assert.throws(() => validateAllowList(placeholder, manifest), /placeholder/);
});
test("allow-list rejects USDC explicitly", () => {
  const f = fixture(); f.allowList.returns[0].asset = manifest.contracts.token;
  assert.throws(() => validateAllowList(f.allowList, manifest), /USDC/);
});
for (const asset of ["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x0000000000000000000000000000000000000802", manifest.contracts.agentAccountCore, manifest.contracts.escrowCore]) {
  test(`no native or protected asset target ${asset}`, () => {
    const f = fixture(); f.allowList.returns[0].asset = asset;
    assert.throws(() => validateAllowList(f.allowList, manifest), /Protected/);
  });
}
test("all deployment addresses (including nested values and keys), signer and zero are forbidden destinations", () => {
  const all = deploymentAddresses(manifest);
  assert.ok(all.has(manifest.contracts.agentAccountCore.toLowerCase()));
  assert.ok(all.has(manifest.bankXcmDeploymentHistory[0].adapter.toLowerCase()));
  for (const dest of [...all, manifest.verifier, "0x0000000000000000000000000000000000000000"]) {
    const f = fixture(); f.allowList.returns[0].destination = dest;
    assert.throws(() => validateAllowList(f.allowList, manifest), /Protected destination/, dest);
  }
  const f = fixture(); f.manifest = { ...manifest, extra: { [destination]: {} } };
  assert.throws(() => validateAllowList(f.allowList, f.manifest), /Protected destination/);
});
test("allow-list signer cannot differ from verifier", () => {
  const f = fixture(); f.allowList.signer = destination;
  assert.throws(() => validateAllowList(f.allowList, manifest), /signer mismatch/);
});
test("requires mainnet, KMS, expected identity and correct chain", async () => {
  for (const change of [(f) => { f.args.profile = "testnet"; }, (f) => { delete f.args.profile; }, (f) => { f.args.useKms = false; }, (f) => { f.args.expectedSigner = destination; }, (f) => { delete f.args.expectedSigner; }, (f) => { f.signer.getAddress = async () => destination; }, (f) => { f.state.chain = 1n; }]) {
    const f = fixture(); change(f); await refuses(f, /mainnet|kms|signer|H160|chain/);
  }
});
test("strict CLI has no destination, asset, RPC, or private-key override", () => {
  assert.deepEqual(parseArgs(["--profile", "mainnet", "--use-kms", "--amount", "10000", "--key", "usdt-2026-11"]), { commit: false, profile: "mainnet", useKms: true, amount: "10000", key: "usdt-2026-11" });
  for (const flag of ["--destination", "--asset", "--private-key", "--rpc"]) assert.throws(() => parseArgs([flag, destination]), /Unknown/);
  assert.throws(() => parseArgs(["--amount"]), /incomplete/);
  assert.throws(() => parseArgs(["--commit", "--commit"]), /Duplicate/);
});
test("amount bounds and unknown keys refuse without signing", async () => {
  for (const amount of ["13000001", "0", "-1", "1.5", "0x10", String(2n ** 256n)]) {
    const f = fixture(); f.args.amount = amount; await refuses(f, /maxRaw|positive/);
  }
  const f = fixture(); f.state.balance = 9999n; await refuses(f, /live balance/);
  const g = fixture(); g.args.key = "other"; await refuses(g, /Unknown/);
});
for (const [field, value] of [["symbol", "USDC"], ["decimals", 18n]]) test(`chain ${field} must match`, async () => {
  const f = fixture(); f.state[field] = value; await refuses(f, /mismatch/);
});
test("dry run sends/signs nothing and prints live chain facts plus stable SHA256 plan", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(f.calls.signs, 0); assert.equal(f.calls.sends.length, 0);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  const output = f.calls.logs[0];
  assert.equal(output.balance, "13000000"); assert.equal(output.symbol, "USDt"); assert.equal(output.decimals, 6);
  assert.equal(output.nativeDot, "2.0000000000000001"); assert.equal(output.nativeDotRaw, String(f.state.native)); assert.equal(output.destination, destination);
  assert.equal(output.amount, "10000"); assert.equal(output.planHash, result.hash);
  assert.equal(result.hash, planHash(result.plan));
  for (const key of ["chainId", "signer", "asset", "destination", "amount", "calldata"]) assert.notEqual(planHash({ ...result.plan, [key]: "changed" }), result.hash, key);
});
test("missing/stale plan or wrong confirmation refuse before signing", async () => {
  for (const patch of [{ expectedPlanHash: undefined }, { expectedPlanHash: "a".repeat(64) }, { confirm: "RETURN wrong" }, { confirm: undefined }]) {
    const f = fixture(); await f.approve(); Object.assign(f.args, patch); await refuses(f, /hash|confirm/);
  }
  const f = fixture(); await f.approve(); f.args.amount = "10001"; await refuses(f, /hash/);
  const g = fixture(); await g.approve(); g.allowList.returns[0].destination = "0x2234567890123456789012345678901234567890"; await refuses(g, /hash/);
});
test("2 DOT uses 18 decimals; below floor after gas cost refuses, unreadable balance refuses", async () => {
  assert.equal(NATIVE_FLOOR, 2_000_000_000_000_000_000n);
  const f = fixture(); f.state.native--; await refuses(f, /gas floor/);
  const g = fixture(); g.provider.getBalance = async () => { throw new Error("RPC unavailable"); }; await refuses(g, /RPC/);
});
test("fresh token and native balances are rechecked immediately before signing", async () => {
  const f = fixture(); await f.approve();
  let reads = 0; const read = f.token.balanceOf;
  f.token.balanceOf = async (...args) => (++reads === 2 ? 9999n : read(...args));
  await refuses(f, /fresh live balance/);
  const g = fixture(); await g.approve(); let nativeReads = 0;
  g.provider.getBalance = async () => (++nativeReads === 2 ? NATIVE_FLOOR : g.state.native);
  await refuses(g, /gas floor changed/);
});
test("commit sends exactly the dry-run transfer once, zero native value, and prints both deltas", async () => {
  const f = fixture(); const plan = await f.approve(); await f.run();
  assert.equal(f.calls.signs, 1); assert.equal(f.calls.sends.length, 1);
  const tx = f.calls.sends[0]; assert.equal(tx.to, committed.returns[0].asset.toLowerCase());
  assert.equal(tx.data, plan.calldata); assert.equal(tx.value, 0n); assert.equal(tx.gasLimit * tx.gasPrice, f.state.cost);
  const decoded = new Interface(["function transfer(address,uint256)"]).decodeFunctionData("transfer", tx.data);
  assert.equal(decoded[0].toLowerCase(), destination); assert.equal(decoded[1], 10000n);
  assert.equal(f.calls.logs.at(-1).signerDecrease, "10000"); assert.equal(f.calls.logs.at(-1).destinationIncrease, "10000");
});
for (const field of ["loss", "gain"]) test(`incorrect ${field} delta fails after one send`, async () => {
  const f = fixture(); await f.approve(); f.state[field] = 9999n;
  await assert.rejects(f.run, /balance delta mismatch/); assert.equal(f.calls.signs, 1);
});
test("unsuccessful receipt fails, never retries", async () => {
  const f = fixture(); await f.approve(); f.state.receipt = 0;
  await assert.rejects(f.run, /receipt unsuccessful/); assert.equal(f.calls.signs, 1);
});
test("workflow accepts only reviewed key/amount/approval, production KMS, shared concurrency, evidence", () => {
  const raw = read(".github/workflows/hosted-signer-asset-return.yml"); const w = yaml.load(raw);
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(), ["amount_raw", "commit", "confirm", "expected_plan_hash", "key"]);
  assert.equal(w.on.workflow_dispatch.inputs.commit.default, false);
  // Scan all env scopes, not only the job; a hidden destination override is forbidden.
  assert.doesNotMatch(raw, /destination|recipient|return_to/i);
  assert.equal(w.concurrency.group, "production-signer-5a6836"); assert.equal(w.concurrency["cancel-in-progress"], false);
  const j = w.jobs["return-asset"]; assert.equal(j.environment, "production"); assert.equal(j.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(Object.keys(j.env).sort(), ["SIGNER_RETURN_AMOUNT_RAW", "SIGNER_RETURN_COMMIT", "SIGNER_RETURN_CONFIRM", "SIGNER_RETURN_KEY", "SIGNER_RETURN_PLAN_HASH", "VPS_HOST", "VPS_PORT", "VPS_USER"]);
  assert.match(raw, /--profile mainnet --key "\$SIGNER_RETURN_KEY" --amount "\$SIGNER_RETURN_AMOUNT_RAW" --use-kms/);
  assert.match(raw, /--expected-signer "\$expected_signer"/);
  assert.match(raw, /--commit --expected-plan-hash "\$SIGNER_RETURN_PLAN_HASH" --confirm "\$SIGNER_RETURN_CONFIRM"/);
  assert.match(raw, /-e AWS_PROFILE=averray-signer/); assert.match(raw, /-e AWS_SDK_LOAD_CONFIG=1/);
  assert.match(raw, /deploy\/docker-compose.mainnet.yml/); assert.match(raw, /\n\s+mainnet-backend \\/);
  for (const dir of ["scripts", "deployments", "mcp-server"]) assert.ok(raw.includes(`-v /srv/agent-stack/app/${dir}:/app/${dir}:ro`));
  assert.match(raw, /return-signer-asset.mjs "\$@"/);
  assert.match(raw, /2>&1 \| tee/); assert.match(raw, /status=\$\{PIPESTATUS\[0\]\}/); assert.match(raw, /exit "\$status"/);
  const evidence = j.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(evidence.if, "always()"); assert.match(evidence.with.path, /signer-asset-return-/);
});
