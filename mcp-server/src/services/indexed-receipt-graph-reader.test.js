import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { graphql } from "graphql";
import * as schema from "../../../indexer/ponder.schema.ts";
import { ESCROW_CORE_ABI } from "../blockchain/abis.js";
import { EvmReceiptGraphReader } from "./fixtures/receipt-graph-chain-oracle.js";
import { ReceiptGraphUnderwriter } from "./receipt-graph-underwriter.js";
import { IndexedReceiptGraphReader } from "./indexed-receipt-graph-reader.js";
import { addresses as a, countingProvider, checkpointData, indexerFetch, NOW, HEAD, WINDOW } from "./fixtures/credit-read-fixture.js";

// Exercise Ponder's installed schema/query builder, not a handwritten GraphQL
// imitation. PGlite and Drizzle are already shipped dependencies of Ponder.
const { buildGraphQLSchema } = await import(new URL("./graphql/index.js", import.meta.resolve("ponder")));
const { encodeCheckpoint } = await import(new URL("./utils/checkpoint.js", import.meta.resolve("ponder")));
const ponderRequire = createRequire(import.meta.resolve("ponder"));
const { eq } = await import(pathToFileURL(ponderRequire.resolve("drizzle-orm")));
const { drizzle } = await import(pathToFileURL(ponderRequire.resolve("drizzle-orm/pglite")));
const { getTableConfig } = await import(pathToFileURL(ponderRequire.resolve("drizzle-orm/pg-core")));

async function storeFixture(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const tables = { settlementSplit: schema.settlementSplit, jobEvent: schema.jobEvent,
    jobStakeEvent: schema.jobStakeEvent, receiptGraphCoverage: schema.receiptGraphCoverage };
  for (const table of Object.values(tables)) {
    const config = getTableConfig(table);
    await pg.exec(`CREATE TABLE "${config.name}" (${config.columns.map((c) => `"${c.name}" ${c.getSQLType()}`).join(", ")})`);
  }
  await pg.exec("CREATE TABLE _ponder_checkpoint (chain_name text, chain_id text, latest_checkpoint text, safe_checkpoint text)");
  const checkpoint = encodeCheckpoint({ blockTimestamp: BigInt(NOW), chainId: 420420419n,
    blockNumber: BigInt(HEAD), transactionIndex: 0n, eventType: 5, eventIndex: 0n });
  await pg.query("INSERT INTO _ponder_checkpoint VALUES ($1, $2, $3, $3)", ["hub", "420420419", checkpoint]);
  const db = drizzle(pg, { schema: tables });
  for (const [i, row] of checkpointData().receiptGraphCoverages.items.entries()) {
    await db.insert(schema.receiptGraphCoverage).values({ ...row, id: String(i), chainId: 420420419,
      fromBlock: BigInt(row.fromBlock), fromTimestamp: BigInt(row.fromTimestamp) });
  }
  const graphSchema = buildGraphQLSchema({ schema: tables });
  const fetchImpl = async (_url, input) => {
    const { query, variables } = JSON.parse(input.body);
    const result = await graphql({
      schema: graphSchema, source: query, variableValues: variables,
      contextValue: { qb: { raw: db, wrap: (options, fn) => (fn ?? options)(db) } }
    });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return Response.json(result);
  };
  return { pg, db, fetchImpl };
}

function reader(fetchImpl, env = {}) {
  return new IndexedReceiptGraphReader({
    env: { INDEXER_STATUS_URL: "http://indexer:42069/status", ...env },
    chainId: 420420419, escrowAddresses: [a.escrow, a.legacy], accountAddress: a.account,
    assetAddress: a.asset, fetchImpl, now: () => new Date(NOW * 1000)
  });
}

test("indexed receipt evidence equals the chain oracle across both escrows and excludes dismissed and out-of-window disputes", async (t) => {
  const { db, fetchImpl } = await storeFixture(t);
  const logs = [];
  const abi = new Interface(ESCROW_CORE_ABI);
  const base = (i, blockNumber) => ({
    id: String(i), jobId: `0x${String(i).padStart(64, "0")}`,
    txHash: `0x${String(i + 100).padStart(64, "0")}`,
    blockNumber: BigInt(blockNumber), timestamp: BigInt(NOW - (HEAD - blockNumber) * 6)
  });
  for (let i = 1; i <= 3; i += 1) {
    const row = { ...base(i, HEAD - i), worker: a.wallet,
      escrowAddress: i === 2 ? a.legacy : a.escrow, asset: a.asset,
      workerAmount: BigInt(i) * 1_000_000n };
    await db.insert(schema.settlementSplit).values(row);
    logs.push({ address: row.escrowAddress, blockNumber: Number(row.blockNumber), transactionHash: row.txHash,
      ...abi.encodeEventLog(abi.getEvent("SettlementSplit"), [row.jobId, a.wallet, a.account, a.asset, row.workerAmount, 0n, 0]) });
  }
  // An old settlement, a different wallet, and a not-yet-indexed block cannot
  // inflate the limit either.
  for (const row of [
    { ...base(8, HEAD - WINDOW / 6 - 1), worker: a.wallet },
    { ...base(9, HEAD - 1), worker: a.account },
    { ...base(10, HEAD + 1), worker: a.wallet }
  ]) {
    await db.insert(schema.settlementSplit).values({ ...row, escrowAddress: a.escrow,
      asset: a.asset, workerAmount: 99_000_000n });
  }
  const disputeRows = [
    { ...base(4, HEAD - 4), escrowAddress: a.legacy, workerPayout: 0n },
    { ...base(5, HEAD - WINDOW / 6 - 1), escrowAddress: a.escrow, workerPayout: 0n },
    // DISMISSED in-window: the fixture worker won and received a payout.
    { ...base(6, HEAD - 6), escrowAddress: a.escrow, workerPayout: 1_000_000n }
  ];
  for (const row of disputeRows) {
    await db.insert(schema.jobEvent).values({ ...row, kind: "DisputeResolved", worker: a.wallet, amount: row.workerPayout });
    logs.push({ address: row.escrowAddress, blockNumber: Number(row.blockNumber), transactionHash: row.txHash,
      ...abi.encodeEventLog(abi.getEvent("DisputeResolved"), [row.jobId, a.account, row.workerPayout, row.jobId, "fixture"]) });
  }
  const provider = countingProvider();
  provider.getLogs = async (filter) => logs.filter((log) => log.address === filter.address
    && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock
    && filter.topics.every((topic, i) => topic === null || log.topics[i] === topic));
  const oracle = new EvmReceiptGraphReader({ provider, escrowAddresses: [a.escrow, a.legacy],
    accountAddress: a.account, now: () => new Date(NOW * 1000) });
  const input = { wallet: a.wallet, asset: a.asset, cashCapRaw: "25000000", postingCapRaw: "25000000" };
  const old = await new ReceiptGraphUnderwriter({ reader: oracle }).evaluate(input);
  const current = await new ReceiptGraphUnderwriter({ reader: reader(fetchImpl) }).evaluate(input);
  assert.equal(old.available, true, old.error);
  assert.equal(current.available, true, current.error);
  const economic = ({ trailingNetRaw, cashLimitRaw, postingLimitRaw, disqualified, disqualificationReason }) =>
    ({ trailingNetRaw, cashLimitRaw, postingLimitRaw, disqualified, disqualificationReason });
  assert.deepEqual(economic(current), economic(old));
  assert.equal(current.trailingNetRaw, "6000000");
  assert.equal(current.evidence.settlementCount, 3);
  assert.equal(current.evidence.upheldDisputeCount, 1);
  assert.equal(old.evidence.upheldDisputeCount, 1);
  assert.equal(current.disqualificationReason, "upheld_dispute_in_window");
  // Remove only the upheld in-window dispute from both fixtures. Keep the
  // dismissed dispute (and the old upheld one) to prove neither disqualifies.
  const upheld = disputeRows[0];
  await db.delete(schema.jobEvent).where(eq(schema.jobEvent.id, upheld.id));
  logs.splice(logs.findIndex((log) => log.transactionHash === upheld.txHash), 1);
  const dismissedOnly = await new ReceiptGraphUnderwriter({ reader: reader(fetchImpl) }).evaluate(input);
  const dismissedOnlyOracle = await new ReceiptGraphUnderwriter({ reader: oracle }).evaluate(input);
  assert.deepEqual(economic(dismissedOnly), economic(dismissedOnlyOracle));
  for (const result of [dismissedOnly, dismissedOnlyOracle]) {
    assert.equal(result.available, true, result.error);
    assert.equal(result.evidence.upheldDisputeCount, 0);
    assert.equal(result.disqualified, false);
    assert.equal(result.disqualificationReason, null);
    assert.equal(result.cashLimitRaw, "3000000");
    assert.equal(result.postingLimitRaw, "6000000");
  }
  await db.insert(schema.jobStakeEvent).values({ id: "slash", account: a.wallet, asset: a.account,
    kind: "claim_fee_slashed", amount: 1n, blockNumber: BigInt(HEAD), timestamp: BigInt(NOW),
    txHash: `0x${"ab".repeat(32)}` });
  const slashed = await new ReceiptGraphUnderwriter({ reader: reader(fetchImpl) }).evaluate(input);
  assert.equal(slashed.disqualificationReason, "slash_in_window");
});

test("indexed receipt evidence sends the configured bearer on every GraphQL fetch", async () => {
  const fixtureFetch = indexerFetch();
  const calls = [];
  const fetchImpl = async (url, input) => {
    calls.push({ url, input });
    return fixtureFetch(url, input);
  };
  await reader(fetchImpl, { INDEXER_GRAPHQL_BEARER_TOKEN: "fixture-indexer-token" }).readWindow({ wallet: a.wallet });
  assert.equal(calls.length, 4, "checkpoint and all three evidence pages are authenticated");
  for (const { url, input } of calls) {
    assert.equal(String(url), "http://indexer:42069/graphql");
    assert.equal(input.method, "POST");
    assert.equal(input.headers.authorization, "Bearer fixture-indexer-token");
    assert.equal(input.headers["content-type"], "application/json");
  }
});

test("indexed receipt evidence omits authorization on every GraphQL fetch when bearer is unset", async () => {
  for (const token of [undefined, "", "   "]) {
    const calls = [];
    const fixtureFetch = indexerFetch();
    const fetchImpl = async (url, input) => {
      calls.push(input);
      return fixtureFetch(url, input);
    };
    await reader(fetchImpl, { INDEXER_GRAPHQL_BEARER_TOKEN: token }).readWindow({ wallet: a.wallet });
    assert.equal(calls.length, 4);
    for (const input of calls) {
      assert.equal(new Headers(input.headers).has("authorization"), false);
      assert.equal(Object.hasOwn(input.headers, "authorization"), false);
      assert.equal(input.headers["content-type"], "application/json");
    }
  }
});

test("indexed evidence refuses incomplete coverage and bounded pagination never becomes a scan fallback", async () => {
  const coverage = checkpointData();
  coverage.receiptGraphCoverages.items[0].fromTimestamp = String(NOW);
  await assert.rejects(reader(indexerFetch({ checkpoint: coverage })).readWindow({ wallet: a.wallet }), /indexer_window_incomplete/);
  let pages = 0;
  const initial = indexerFetch();
  const endless = async (url, input) => {
    if (JSON.parse(input.body).query.includes("CreditEvidenceCheckpoint")) return initial(url, input);
    pages += 1;
    return Response.json({ data: { page: { items: [], pageInfo: { hasNextPage: true, endCursor: String(pages) } } } });
  };
  await assert.rejects(reader(endless).readWindow({ wallet: a.wallet }), /indexer_evidence_limit/);
  assert.ok(pages <= 30, "three paginated tables are bounded to ten pages each");
});
