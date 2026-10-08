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
    const envelope = { schemaVersion: "averray.badge-list-item.v1", document,
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

test("overview latest receipt label reads timestamps through the envelope adapter", () => {
  const page = read("../../app/(authed)/overview/page.tsx");
  const source = page.slice(page.indexOf("function latestReceiptLabel("), page.indexOf("function extractRows("));
  const { latestReceiptLabel } = compile('import { extractReceiptRows } from "./adapter";\nexport ' + source, {
    "./adapter": adapters
  });
  for (const kind of ["run", "badge"]) {
    const document = kind === "run" ? { timestamps: { verifiedAt: "2026-10-08T13:45:00Z" } }
      : { averray: { sessionId: "fixture", completedAt: "2026-10-08T13:45:00Z" } };
    const items = [{ schemaVersion: "averray.badge-list-item.v1", document, unsignedPresentation: { kind, sessionId: "fixture" } }];
    assert.equal(latestReceiptLabel({ items }, false), "13:45 UTC");
  }
  assert.match(page, /import \{ extractReceiptRows \} from "@\/lib\/api\/receipt-adapters"/u);
});

test("live receipt events invalidate every paginated badge SWR key and the overview", () => {
  let events;
  const keys = [];
  const { LiveDataBridge } = compile(read("../../components/shell/LiveDataBridge.tsx"), {
    react: { useEffect: (effect) => effect() },
    swr: { mutate: (key) => keys.push(key) },
    "@/lib/events/stream": { startEventStream: (options) => { events = options; return () => {}; } },
    "@/lib/events/stream-status": { resetStream() {}, reportStreamState() {}, recordStreamEvent() {} },
    "@/lib/auth/use-auth": { useAuth: () => ({ authenticated: true, wallet: "fixture" }) }
  });
  LiveDataBridge();
  for (const topic of ["verification.resolved", "escrow.job_closed", "reputation.badge_minted", "gap"]) {
    keys.length = 0;
    if (topic === "gap") events.onGap(); else events.onEvent({ topic });
    const predicate = keys.find((key) => typeof key === "function");
    assert.ok(predicate, topic);
    for (const key of ["/badges", "/badges?limit=50", "/badges?limit=50&cursor=next"]) assert.equal(predicate(key), true, topic);
    assert.equal(predicate("/jobs"), false);
    assert.equal(predicate(undefined), false);
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
