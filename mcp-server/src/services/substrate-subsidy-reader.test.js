import assert from "node:assert/strict";
import test from "node:test";
import { hexlify } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import { accountId32FromSs58, h160ToSs58 } from "../core/wallet-identity.js";
import { createAdminYieldSubsidyRoutes } from "../protocols/http/admin-yield-subsidy-routes.js";
import { SubstrateSubsidyReader } from "./substrate-subsidy-reader.js";
import { YieldAttributionService } from "./yield-attribution-service.js";

const POOL = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
const OTHER_POOL = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const EXTRINSIC = "0x272c0fb89deeb10635a8be9b19876a4a82ffe5f4f470de953c8bc5549947b052";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const BLOCK = 20421344;
const FROM = `0x${"33".repeat(32)}`;
const recipient = (pool) => hexlify(accountId32FromSs58(h160ToSs58(pool)));
const event = (section, method, data = [], index = 1) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: index }, event: { section, method, data }
});

function fixture({ pool = POOL } = {}) {
  const records = [event("assets", "Transferred", ["1337", FROM, recipient(POOL), "600000"]), event("system", "ExtrinsicSuccess")];
  const header = { number: BLOCK };
  const api = {
    rpc: { chain: {
      async getBlockHash(number) { assert.equal(number, BLOCK); return BLOCK_HASH; },
      async getFinalizedHead() { return BLOCK_HASH; },
      async getHeader() { return { number: BLOCK + 1 }; },
      async getBlock(hash) {
        assert.equal(hash, BLOCK_HASH);
        return { block: { header, extrinsics: [{ hash: `0x${"ff".repeat(32)}` }, { hash: EXTRINSIC }] } };
      }
    } },
    async at(hash) {
      assert.equal(hash, BLOCK_HASH);
      return { query: {
        system: { async events() { return records; } },
        timestamp: { async now() { return 1788894000000n; } }
      } };
    }
  };
  const balanceReader = { async getSubstrateApi(endpoint) { assert.equal(endpoint, "wss://hub.example.test"); return api; } };
  const reader = new SubstrateSubsidyReader({ balanceReader, endpoint: "wss://hub.example.test" });
  const stateStore = new MemoryStateStore();
  const service = new YieldAttributionService({
    poolAddress: pool, assetAddress: "0x0000053900000000000000000000000001200000", chainId: 420420419,
    stateStore, substrateReader: reader,
    provider: { getTransaction() { assert.fail("Substrate evidence must not require an EVM receipt"); } }
  });
  const attest = (extra = {}) => service.attestSubsidy({ extrinsicHash: EXTRINSIC, blockNumber: BLOCK, attestedBy: OPERATOR, ...extra });
  return { records, header, api, reader, stateStore, service, attest };
}

test("Asset Hub subsidy takes its amount from the transfer event despite operator amount mutation", async () => {
  const f = fixture();
  const first = await f.attest({ amountRaw: "1" });
  const second = await f.attest({ amountRaw: "999999999999" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.entry.amount.raw, "600000");
  assert.deepEqual(second.entry, first.entry);
  assert.equal(first.entry.blockNumber, BLOCK);
  assert.equal(first.entry.timestamp, new Date(1788894000000).toISOString());
  assert.deepEqual(first.entry.verification, { method: "substrate_extrinsic", chainId: 420420419, blockHash: BLOCK_HASH, extrinsicIndex: 1, eventIndex: 0 });
  assert.equal((await f.stateStore.listYieldSubsidyEntries()).length, 1);
  const changedEvent = fixture();
  changedEvent.records[0].event.data[3] = "123456";
  assert.equal((await changedEvent.attest({ amountRaw: "600000" })).entry.amount.raw, "123456", "changing chain evidence, not operator input, changes the recorded amount");
});

for (const [name, mutate, reason] of [
  ["different asset", (f) => { f.records[0].event.data[0] = "1984"; }, "wrong_asset"],
  ["different recipient", (f) => { f.records[0].event.data[2] = recipient(OTHER_POOL); }, "wrong_recipient"],
  ["failed execution", (f) => { f.records[1].event.method = "ExtrinsicFailed"; }, "failed"]
]) {
  test(`Asset Hub subsidy rejects ${name} with its distinct reason`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.attest(), { code: `yield_subsidy_extrinsic_${reason}` });
    assert.deepEqual(await f.stateStore.listYieldSubsidyEntries(), []);
  });
}

test("configured pool mutation changes the only accepted EVM-derived AccountId32 recipient", async () => {
  assert.equal(h160ToSs58(POOL), "14WWMVMGTHrUWxNW7H5f514t19hvTBvWcbGXXUQsMkjFgTTX");
  const original = fixture();
  assert.equal((await original.attest()).entry.amount.raw, "600000");
  const changed = fixture({ pool: OTHER_POOL });
  await assert.rejects(changed.attest(), { code: "yield_subsidy_extrinsic_wrong_recipient" });
  changed.records[0].event.data[2] = h160ToSs58(OTHER_POOL);
  assert.equal((await changed.attest()).entry.amount.raw, "600000");
  assert.equal((await changed.stateStore.listYieldSubsidyEntries())[0].pool, OTHER_POOL);
});

test("Substrate proof is scoped to the named extrinsic and rejects borrowed success or transfer events", async () => {
  for (const changedRecord of [0, 1]) {
    const f = fixture();
    f.records[changedRecord].phase.asApplyExtrinsic = 0;
    await assert.rejects(f.attest(), { code: `yield_subsidy_extrinsic_${changedRecord === 0 ? "transfer_missing" : "failed"}` });
  }
  const absent = fixture();
  await assert.rejects(absent.attest({ extrinsicHash: `0x${"ee".repeat(32)}` }), { code: "yield_subsidy_extrinsic_not_found" });
  const ambiguous = fixture();
  ambiguous.records.push(ambiguous.records[0]);
  await assert.rejects(ambiguous.attest(), { code: "yield_subsidy_extrinsic_ambiguous_transfer" });
});

test("Substrate proof fails closed on unfinalized blocks missing timestamps and bounded read timeout", async () => {
  const unfinalized = fixture();
  unfinalized.api.rpc.chain.getHeader = async () => ({ number: BLOCK - 1 });
  await assert.rejects(unfinalized.attest(), { code: "yield_subsidy_extrinsic_not_finalized" });
  const missing = fixture();
  missing.api.at = async () => ({ query: { system: { events: async () => missing.records }, timestamp: { now: async () => "unreadable" } } });
  await assert.rejects(missing.attest(), { code: "yield_subsidy_extrinsic_timestamp_unreadable" });
  const reader = new SubstrateSubsidyReader({ endpoint: "wss://offline.example.test", timeoutMs: 5, balanceReader: { getSubstrateApi: () => new Promise(() => {}) } });
  await assert.rejects(reader.read({ extrinsicHash: EXTRINSIC, blockNumber: BLOCK, poolAddress: POOL }), { code: "yield_subsidy_extrinsic_read_timeout" });
});

test("admin subsidy route accepts only evidence locators and rejects operator amounts", async () => {
  const f = fixture();
  let payload = { extrinsicHash: EXTRINSIC, blockNumber: BLOCK };
  let response;
  const route = createAdminYieldSubsidyRoutes({
    async authMiddleware(_request, _url, options) { assert.deepEqual(options, { requireCapability: "admin:yield-subsidy:attest" }); return { wallet: OPERATOR }; },
    async readJsonBody() { return payload; },
    respond(_response, status, body) { response = { status, body }; },
    yieldAttributionService: f.service
  });
  const invoke = () => route({ request: { method: "POST" }, response: {}, pathname: "/admin/deposit-pool/subsidies" });
  await invoke();
  assert.equal(response.status, 201);
  assert.equal(response.body.entry.amount.raw, "600000");
  for (const extra of [{ amountRaw: "1" }, { txHash: EXTRINSIC }, { recipient: OTHER_POOL }]) {
    payload = { extrinsicHash: EXTRINSIC, blockNumber: BLOCK, ...extra };
    await assert.rejects(invoke(), { code: "invalid_request" });
  }
});
