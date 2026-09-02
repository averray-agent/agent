import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatReceiptKindBreakdown,
  receiptKindBreakdown,
  RECEIPT_KIND_ORDER,
} from "./receipt-metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");

test("receiptKindBreakdown counts receipt shapes separately from badge totals", () => {
  assert.deepEqual(RECEIPT_KIND_ORDER, ["run", "badge", "settle", "policy"]);
  assert.deepEqual(
    receiptKindBreakdown([
      { kind: "run" },
      { kind: "run" },
      { kind: "badge" },
      { kind: "settle" },
      { kind: "policy" },
      { kind: "unknown" },
    ]),
    { run: 2, badge: 1, settle: 1, policy: 1 }
  );
});

test("formatReceiptKindBreakdown renders the operator-facing KPI meta", () => {
  assert.equal(
    formatReceiptKindBreakdown([
      { kind: "badge" },
      { kind: "run" },
      { kind: "policy" },
      { kind: "run" },
    ]),
    "run 2 · badge 1 · settle 0 · policy 1"
  );
});

test("receipts and agents surfaces distinguish receipt total from badge receipt count", () => {
  const receiptsPage = readFileSync(
    resolve(appRoot, "app/(authed)/receipts/page.tsx"),
    "utf8"
  );
  const agentsStrip = readFileSync(
    resolve(appRoot, "components/agents/AgentsAggregateStrip.tsx"),
    "utf8"
  );

  assert.match(receiptsPage, /formatReceiptKindBreakdown\(rows\)/u);
  assert.match(receiptsPage, /label: "Receipt ledger"/u);
  assert.match(agentsStrip, /label="Badge receipts"/u);
  assert.match(agentsStrip, /verified outcomes only/u);
});
