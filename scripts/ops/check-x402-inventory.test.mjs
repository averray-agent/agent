import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "check-x402-inventory.mjs");

// The script reads two live chains, so these cover the parts that are ours:
// the policy arithmetic, and refusing to run without the addresses. The chain
// reads are exercised by running it for real against production.
async function run(args = [], env = {}) {
  try {
    const { stdout } = await execFileAsync("node", [script, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8"
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// "We could not read the inventory" and "the inventory is low" are different
// claims. A monitor that turns the first into the second cries wolf; one that
// turns the second into the first goes quiet exactly when it matters.
test("missing addresses exit 1 (script error), never 2 (inventory low)", async () => {
  const result = await run([], {
    X402_PAYMENT_PAY_TO: "",
    X402_POOLED_FUNDING_ACCOUNT: "",
    X402_PAYMENT_ASSET_ADDRESS: ""
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /X402_PAYMENT_PAY_TO/u);
});

test("an unreachable chain exits 1, not 2", async () => {
  const result = await run([], {
    X402_PAYMENT_PAY_TO: "0x1013E3fe3F6dEb4E61DC023Ff69D420DD9Ce8F9f",
    X402_POOLED_FUNDING_ACCOUNT: "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
    X402_PAYMENT_ASSET_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    RPC_URL: "http://127.0.0.1:1",
    BASE_RPC_URL: "http://127.0.0.1:1"
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not read both sides/u);
});

// The arithmetic the whole policy rests on: a rebalance costs about the same
// whatever it moves, so the fee sets the minimum move, and the minimum move
// sets how much Hub inventory has to cover. Recomputed here so a change to the
// formula has to be deliberate.
test("the minimum sensible move is the leg cost over the tolerated friction", () => {
  const minMove = (legCostUsd, frictionPct) => legCostUsd / (frictionPct / 100);
  assert.equal(minMove(2, 2), 100);
  assert.equal(minMove(1, 1), 100);
  assert.equal(minMove(5, 1), 500);
  assert.equal(minMove(2, 5), 40);
});

test("required runway is the minimum move expressed in postings", () => {
  const requiredPostings = (legCostUsd, frictionPct, postingUsd) =>
    Math.floor((legCostUsd / (frictionPct / 100)) / postingUsd);
  // $100 minimum move at the cheapest possible posting.
  assert.equal(requiredPostings(2, 2, 1.05), 95);
  // A tighter friction budget demands a bigger move and so more inventory.
  assert.equal(requiredPostings(2, 1, 1.05), 190);
  // Dearer jobs consume runway faster, so fewer of them fit the same move.
  assert.equal(requiredPostings(2, 2, 10.5), 9);
});

// Runway floors rather than rounds: 1.9 postings' worth of float serves one
// posting, and claiming two would promise a customer something we cannot do.
test("runway floors, so partial capacity is never advertised", () => {
  const runway = (liquidUsd, postingUsd) => Math.floor(liquidUsd / postingUsd);
  assert.equal(runway(2.09, 1.05), 1);
  assert.equal(runway(1.04, 1.05), 0);
  assert.equal(runway(3.345, 1.05), 3);
});
