import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { publicReceiptUrl } from "./public-receipt-url.js";
import { flattenMarkdownLead } from "./markdown-lead.js";

const root = new URL("../../", import.meta.url);
const require = createRequire(new URL("../../package.json", import.meta.url));
const read = (path) => readFileSync(new URL(path, root), "utf8");
function load(path, modules = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => modules[name] ?? require(name), console, AbortSignal, ...globals });
  return exports;
}
function storeFixture(initial = {}) {
  const data = new Map(Object.entries(initial));
  const localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  return load("lib/auth/token-store.ts", {}, { localStorage, window: { addEventListener() {} } });
}

test("session notice ignores an earlier visit's expiry but reports a stored expired session", () => {
  const fresh = storeFixture({ "averray:auth-last-reason": "siwe_expired" });
  assert.equal(fresh.getAuthSnapshot().lastReason, undefined);
  fresh.clearSession("token_refresh_rejected");
  assert.equal(fresh.getAuthSnapshot().lastReason, undefined);
  fresh.writeSession({ token: "fixture", wallet: "wallet", expiresAt: "2099-01-01T00:00:00Z", roles: [] });
  fresh.clearSession("token_refresh_rejected");
  assert.equal(fresh.getAuthSnapshot().lastReason, "token_refresh_rejected");
  const expired = storeFixture({ "averray:auth-token": "fixture", "averray:auth-wallet": "wallet", "averray:auth-expires-at": "2000-01-01T00:00:00Z" });
  assert.equal(expired.getAuthSnapshot().lastReason, "siwe_expired");
  const render = (auth) => {
    const { WalletSessionNotice } = load("components/auth/WalletSessionNotice.tsx", {
      "@/lib/auth/use-auth": { useAuth: () => auth },
      "@/lib/auth/use-wallet-provider": { useWalletConnection: () => ({ status: "session_expired" }) },
      "@/lib/auth/wallet-provider.js": {},
      "@/components/ui/button": { Button: ({ children }) => React.createElement("span", null, children) },
      "next/link": { default: ({ children }) => React.createElement("a", null, children) }
    });
    return renderToStaticMarkup(React.createElement(WalletSessionNotice));
  };
  assert.equal(render({ authenticated: false }), "");
  assert.match(render(expired.getAuthSnapshot()), /sign-in expired/);
});

test("sign out clears wallet subscribers and API token before a pending logout response", async () => {
  const session = storeFixture();
  session.writeSession({ token: "fixture", wallet: "wallet", expiresAt: "2099-01-01T00:00:00Z", roles: [] });
  let observed;
  session.onAuthChange((snapshot) => { observed = snapshot; });
  let clientToken = "fixture";
  let release;
  const { signOut } = load("lib/auth/siwe.ts", {
    "./token-store": session,
    "@/lib/api/client": { setClientToken: (token) => { clientToken = token; } },
    "./siwe-core.js": {},
    "./wallet-provider.js": {}
  }, { fetch: () => new Promise((resolve) => { release = resolve; }) });
  const pending = signOut();
  assert.equal(observed.authenticated, false);
  assert.equal(observed.wallet, undefined);
  assert.equal(clientToken, undefined);
  release({ ok: true });
  await pending;
});

test("job terms render GFM without executable HTML, unsafe URLs or remote images", () => {
  const { IssueMarkdown } = load("components/runs/IssueMarkdown.tsx", {
    "react-markdown": { default: ReactMarkdown },
    "remark-gfm": { default: remarkGfm },
    "@/lib/ui/markdown-lead.js": { flattenMarkdownLead },
    "@/lib/utils/cn": { cn: (...parts) => parts.filter(Boolean).join(" ") }
  });
  const html = renderToStaticMarkup(React.createElement(IssueMarkdown, null,
    "**Important**\n\n- [x] done\n\n| Term | Value |\n| --- | --- |\n| a | b |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![image](https://outside.test/track.png)"));
  assert.match(html, /<strong[^>]*>Important<\/strong>/);
  assert.match(html, /<table/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /<script|href="javascript:|<img/);
  assert.match(read("components/work/WorkJobDetail.tsx"), /<IssueMarkdown[^>]*>\{definition.description/);
  assert.match(read("components/work/WorkJobDetail.tsx"), /<IssueMarkdown>\{item\}<\/IssueMarkdown>/);
});

test("receipt raw links use API origin and the real encoded session, not display ids", () => {
  const path = "/badges/" + encodeURIComponent("job:wallet/claim-2");
  assert.equal(publicReceiptUrl(path, undefined), "https://api.averray.com" + path);
  assert.equal(publicReceiptUrl(path + "/run", "https://api.test/"), "https://api.test" + path + "/run");
  const { buildReceiptDrawer } = load("lib/api/receipt-adapters.ts", {
    "./receipt-signers": { extractReceiptSigners: () => [] },
    "@/lib/ui/receipt-signature-verification": { selectCanonicalReceiptDocument: () => null, receiptHasSignature: () => false },
    "@/lib/ui/receipt-asset-context": { formatReceiptAssetLine: () => undefined },
    "@/lib/ui/public-receipt-url.js": { publicReceiptUrl }
  });
  for (const kind of ["badge", "run"]) {
    const drawer = buildReceiptDrawer({ id: "r_short_display_id", sessionId: "job:wallet/claim-2", kind, signers: [] }, null);
    assert.equal(drawer.evidenceRawHref, "https://api.averray.com" + path + (kind === "run" ? "/run" : ""));
  }
  const source = read("lib/api/receipt-adapters.ts");
  assert.match(source, /encodeURIComponent\(row.sessionId\)/);
  assert.match(source, /evidenceRawHref: publicReceiptUrl\(evidencePath\)/);
  assert.doesNotMatch(source, /encodeURIComponent\(row.id\)/);
});

test("live closed external state wins over catalogue open in app counts", () => {
  const { classifyJobRow } = load("lib/api/job-lifecycle.ts");
  const result = classifyJobRow({ lifecycle: { state: "open", status: "open" }, claimState: "unclaimable", claimable: false, reason: "external_posting_not_open_on_chain" });
  assert.equal(result.open, false);
  assert.equal(result.claimable, false);
});

test("every lifecycle enum has defined actions and labels; terminal rows stay visible and in terminal buckets", () => {
  const lifecycle = load("lib/api/job-lifecycle.ts");
  const states = [...read("lib/api/job-lifecycle.ts").match(/export type JobLifecycleState =([\s\S]*?);/)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(states.sort(), ["archived", "cancelled", "closed", "open", "paused", "stale"]);
  for (const state of states) {
    assert.ok(Array.isArray(lifecycle.availableActions(state)), state);
    assert.ok(lifecycle.formatLifecycleLabel(state), state);
  }
  for (const state of ["closed", "cancelled"]) {
    const row = { lifecycle: { state, status: state }, claimable: false };
    assert.equal(lifecycle.buildJobLifecycle(row.lifecycle).state, state);
    assert.equal(lifecycle.availableActions(state).length, 0);
    assert.equal(lifecycle.visibleInDefaultRuns(row.lifecycle), true);
    const classified = lifecycle.classifyJobRow(row);
    assert.equal(classified[state], true);
    assert.equal(classified.open, false);
    assert.equal(classified.claimable, false);
  }
  assert.match(read("app/(authed)/runs/page.tsx"), /\(r\) => visibleInDefaultRuns\(r.lifecycle\)/);
  assert.match(read("components/runs/RunQueueTable.tsx"), /\["archived", "closed", "cancelled"\]\.includes\(state\)/);
});
