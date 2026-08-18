import assert from "node:assert/strict";
import test from "node:test";

import { buildCapitalAtWorkVital } from "./capital-at-work.js";

test("a live feed reports the real allocation and reads healthy", () => {
  const tile = buildCapitalAtWorkVital({ presence: "live", value: "5.00", unit: "USDC" });
  assert.equal(tile.value, "5.00");
  assert.equal(tile.unit, "USDC");
  assert.equal(tile.deltaTone, "good");
});

test("an unreadable feed reports Unknown, never a confident zero", () => {
  // Regression lock (2026-08-18): this tile rendered a green "0 USDC" while
  // 5.0 USDC was demonstrably deployed at the venue — pool totalAssets
  // 20.446982 minus idle 15.446982. The strategy feed was blind (#1121), not
  // empty. Absence of a reading is not a reading of absence.
  for (const presence of ["unavailable", "locked", "loading"]) {
    const tile = buildCapitalAtWorkVital({ presence, value: "0", unit: "USDC" });
    assert.equal(tile.value, "Unknown", `${presence} must not state a value`);
    assert.notEqual(tile.deltaTone, "good", `${presence} must not read as healthy`);
    assert.equal(tile.unit, undefined, `${presence} must not carry a unit it cannot justify`);
  }
});

test("the refusal says which feed failed and that allocation is unobservable", () => {
  assert.match(
    buildCapitalAtWorkVital({ presence: "unavailable", value: "0" }).delta,
    /strategy feed unavailable — allocation not observable/u
  );
  assert.match(
    buildCapitalAtWorkVital({ presence: "locked", value: "0" }).delta,
    /locked for this session/u
  );
  assert.match(buildCapitalAtWorkVital({ presence: "loading", value: "0" }).delta, /waiting/u);
});
