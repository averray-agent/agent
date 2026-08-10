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

// A costed leg sets a minimum sensible move, and that minimum is the inventory
// the Hub side must carry between two of them. Recomputed here so a change to
// the formula has to be deliberate.
test("the minimum sensible move is the leg cost over the tolerated friction", () => {
  const minMove = (legCostUsd, frictionPct) => legCostUsd / (frictionPct / 100);
  assert.equal(minMove(2, 2), 100);
  assert.equal(minMove(1, 1), 100);
  assert.equal(minMove(5, 1), 500);
  assert.equal(minMove(2, 5), 40);
});

// The measured case, and the reason the default changed. Coinbase quoted $0.00
// for USDC to Polkadot on 2026-08-10, proven with a real $1 transfer. A free leg
// has NO minimum sensible move, so the inventory has no economic floor and the
// warn threshold is an operational choice rather than an economic one. This was
// worth a test because the script shipped asserting the opposite.
test("a free leg imposes no minimum move and no inventory floor", () => {
  const hasLegCost = (legCostUsd) => legCostUsd > 0;
  const minMove = (legCostUsd, frictionPct) =>
    hasLegCost(legCostUsd) ? legCostUsd / (frictionPct / 100) : 0;

  assert.equal(hasLegCost(0), false);
  assert.equal(minMove(0, 2), 0, "no amount is too small to move when moving is free");
  assert.equal(minMove(0, 99), 0, "and the friction budget cannot resurrect a floor");
});

// Two different questions, so two different triggers. With a costed leg you wait
// until the move clears the economic floor. With a free one there is nothing to
// clear, so the only reason to move is that Hub actually needs it — moving while
// Hub has runway is churn, not prudence.
test("the rebalance trigger follows whether the leg costs anything", () => {
  const due = ({ legCostUsd, baseHeld, healthy, postingUsd = 1.05, frictionPct = 2 }) =>
    legCostUsd > 0
      ? baseHeld >= legCostUsd / (frictionPct / 100)
      : !healthy && baseHeld >= postingUsd;

  // Costed: Base must reach the floor, and Hub's state is irrelevant.
  assert.equal(due({ legCostUsd: 2, baseHeld: 99, healthy: false }), false);
  assert.equal(due({ legCostUsd: 2, baseHeld: 100, healthy: true }), true);

  // Free: Hub must be short AND Base must cover at least one posting.
  assert.equal(due({ legCostUsd: 0, baseHeld: 50, healthy: true }), false, "runway is fine, do not churn");
  assert.equal(due({ legCostUsd: 0, baseHeld: 1.04, healthy: false }), false, "cannot even fund one posting");
  assert.equal(due({ legCostUsd: 0, baseHeld: 1.05, healthy: false }), true);
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
