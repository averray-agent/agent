import test from "node:test";
import assert from "node:assert/strict";

import { auditEventsToCsv } from "./audit-export.js";

test("audit CSV serializes the current view and escapes cells", () => {
  const csv = auditEventsToCsv([
    {
      id: "audit-1",
      day: "today",
      at: "12:01:00",
      source: "operator",
      category: "policy",
      action: "policy.changed",
      summary: "Updated receipt gate",
      actor: { handle: "Operator, primary", address: "0x1234" },
      target: "settle/receipt-before-payout@v1",
      hash: "0xabcd",
      link: { label: "Open \"policy\"", href: "/policies" },
    },
  ]);

  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^id,day,at,source,category,action,summary/u);
  assert.match(lines[1], /"Operator, primary"/u);
  assert.match(lines[1], /"Open ""policy"""/u);
});
