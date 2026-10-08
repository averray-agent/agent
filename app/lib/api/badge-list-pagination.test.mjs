import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as signature from "../ui/receipt-signature-verification.js";
import * as assets from "../ui/receipt-asset-context.js";
import * as urls from "../ui/public-receipt-url.js";
import * as signers from "./receipt-signers.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
function compile(source, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } }).outputText, { exports, require: (key) => {
    if (!modules[key]) throw new Error(key);
    return modules[key];
  }, Date, TextEncoder });
  return exports;
}
const adapters = compile(read("./receipt-adapters.ts"), {
  "./receipt-signers": signers,
  "@/lib/ui/receipt-signature-verification": signature,
  "@/lib/ui/receipt-asset-context": assets,
  "@/lib/ui/public-receipt-url.js": urls
});

test("receipt list envelopes supply rows and preserve the canonical signed document for the drawer", () => {
  for (const kind of ["run", "badge"]) {
    const document = { sessionId: "session-1", jobId: "job-1", signature: { kid: "badge-1" },
      signers: [], averray: { sessionId: "session-1" } };
    const envelope = { schemaVersion: "averray.receipt-envelope.v1", document,
      unsignedPresentation: { kind, sessionId: "session-1", jobId: "job-1",
        issuedAt: "2026-10-08T12:00:00Z", result: "PASS" } };
    const [row] = adapters.extractReceiptRows({ items: [envelope], limit: 50, nextCursor: "more" });
    assert.equal(row.kind, kind);
    assert.equal(row.sessionId, "session-1");
    assert.equal(row.listRow, envelope);
    const drawer = adapters.buildReceiptDrawer(row, null);
    assert.equal(drawer.canonicalDocument, document);
    assert.equal(Object.hasOwn(drawer.canonicalDocument, "result"), false);
  }
});

test("receipt pages pass cursors and show controls outside the desktop-only layout", () => {
  const hooks = read("./hooks.ts");
  const page = read("../../app/(authed)/receipts/page.tsx");
  assert.match(hooks, /badges\?limit=50.*encodeURIComponent\(cursor\)/u);
  assert.match(page, /useBadges\(cursors\.at\(-1\)/u);
  assert.match(page, /setCursors\(\(pages\) => \[\.\.\.pages, next\]\)/u);
  assert.match(page, /Counts and exports cover this page/u);
  assert.ok(page.indexOf('aria-label="Receipt pages"') < page.indexOf('className="hidden flex-col'));
});
