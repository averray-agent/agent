import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as schema from "../../ponder.schema.ts";

const requirePonder = createRequire(import.meta.resolve("ponder"));
const { getTableConfig } = await import(pathToFileURL(requirePonder.resolve("drizzle-orm/pg-core")).href);

test("receipt-graph indexed lookup keys include worker and timestamp", () => {
  for (const [table, identity] of [
    [schema.settlementSplit, "worker"],
    [schema.jobEvent, "worker"],
    [schema.jobStakeEvent, "account"]
  ] as const) {
    const config = getTableConfig(table);
    assert.ok(config.indexes.some((entry: { config: { columns: { name: string }[] } }) =>
      entry.config.columns.map((column) => column.name).join(",") === `${identity},timestamp`));
  }
});

test("receipt-graph coverage is replay-derived and resolved disputes pin their own worker", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /ponder\.on\(\x60\$\{contract\}:setup/);
  assert.match(source, /fromBlock = BigInt\(source.startBlock \?\? 0\)/);
  assert.match(source, /fromTimestamp: block.timestamp/);
  assert.match(source, /source.startBlock === "latest"\) return/);
  const dispute = source.split('ponder.on("EscrowCore:DisputeResolved"')[1]?.split('ponder.on(')[0] ?? "";
  assert.match(dispute, /const live = await syncJob/);
  assert.match(dispute, /worker: live.worker.toLowerCase\(\)/);
  assert.match(dispute, /escrowAddress: event.log.address.toLowerCase\(\)/);
  assert.match(dispute, /amount: event.args.workerPayout/);
});
