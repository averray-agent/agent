import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";

import { TREASURY_POLICY_ABI, XCM_WRAPPER_ABI } from "./abis.js";

const GATEWAY_SOURCE = readFileSync(fileURLToPath(new URL("./gateway.js", import.meta.url)), "utf8");
const XCM_WRAPPER_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../contracts/XcmWrapperV22.sol", import.meta.url)),
  "utf8"
);

// The gateway guards genuinely-optional policy reads with `typeof ... === "function"`.
// Everything else it calls must exist on the ABI, or ethers hands back `undefined`
// and the call dies as "X is not a function" at runtime instead of at build time.
function policyMethodsCalledUnconditionally(source) {
  const guarded = new Set(
    [...source.matchAll(/typeof this\.policyContract\.(\w+) === "function"/g)].map((m) => m[1])
  );
  const called = new Set([...source.matchAll(/this\.policyContract\.(\w+)\(/g)].map((m) => m[1]));
  return [...called].filter((name) => !guarded.has(name)).sort();
}

test("TreasuryPolicy ABI defines every policy method the gateway calls unconditionally", () => {
  const iface = new Interface(TREASURY_POLICY_ABI);
  const missing = policyMethodsCalledUnconditionally(GATEWAY_SOURCE).filter(
    (name) => iface.getFunction(name) === null
  );
  assert.deepEqual(
    missing,
    [],
    `TreasuryPolicy ABI is missing ${missing.join(", ")} — the gateway calls these without a typeof guard`
  );
});

test("the scan actually finds gateway policy calls", () => {
  // Guards the guard: if the regex ever stops matching, the test above passes vacuously.
  const found = policyMethodsCalledUnconditionally(GATEWAY_SOURCE);
  assert.ok(found.length > 5, `expected many unconditional policy calls, found ${found.length}`);
  assert.ok(found.includes("approvedStrategies"), "approvedStrategies should be scanned as unconditional");
});

test("XcmWrapperV22 ABI custom errors exactly match the Solidity source", () => {
  const declarations = [...XCM_WRAPPER_SOURCE.matchAll(/^\s*error\s+([^;]+);/gmu)]
    .map((match) => `error ${match[1]}`);
  assert.equal(declarations.length, 14, "source scan must anchor the complete XcmWrapperV22 error set");
  const sourceErrors = new Interface(declarations).fragments
    .filter((fragment) => fragment.type === "error")
    .map((fragment) => fragment.format("sighash"))
    .sort();
  const runtimeErrors = new Interface(XCM_WRAPPER_ABI).fragments
    .filter((fragment) => fragment.type === "error")
    .map((fragment) => fragment.format("sighash"))
    .sort();
  assert.deepEqual(runtimeErrors, sourceErrors);
});
