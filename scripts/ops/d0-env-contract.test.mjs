import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url)
];

const EXPECTED = Object.freeze({
  WORKER_DAILY_EXPOSURE_BUDGET_RAW: "1500000",
  WORKER_LIFETIME_CATALOGUE_CREDIT_RAW: "10000000",
  WORKER_GRADUATION_SETTLED_JOBS: "10",
  WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW: "25000000",
  WORKER_DEPOSIT_VESTING_HOURS: "48",
  WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW: "500000",
  WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW: "1000000",
  WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI: "1000"
});

test("both backend env templates carry D0 defaults and omit the retired deposit allowance", async () => {
  for (const templateUrl of TEMPLATES) {
    const source = await readFile(templateUrl, "utf8");
    for (const [name, value] of Object.entries(EXPECTED)) {
      assert.match(source, new RegExp(`^${name}=${value}$`, "mu"), templateUrl.pathname);
    }
    assert.doesNotMatch(
      source,
      /^WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI=/mu,
      templateUrl.pathname
    );
  }
});
