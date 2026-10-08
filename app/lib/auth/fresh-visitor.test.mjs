import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import * as decisions from "./auth-refresh-decisions.js";
import * as probe from "./session-probe.js";

const root = new URL("../../", import.meta.url);
const require = createRequire(new URL("../../package.json", import.meta.url));
function load(path, modules, globals) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => modules[name] ?? require(name),
    console, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, ...globals });
  return exports;
}

function fixture(path) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.averray.test" + path });
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage };
  const store = load("lib/auth/token-store.ts", {}, globals);
  const calls = [];
  const siwe = (fetch = async (...args) => { calls.push(args); return { status: 401 }; }) =>
    load("lib/auth/siwe.ts", { "./token-store": store, "@/lib/api/client": { setClientToken() {} },
      "./siwe-core.js": {}, "./wallet-provider.js": {} }, { ...globals, fetch });
  return { dom, globals, store, calls, siwe };
}

test("fresh /sign-in and /work visitors render no expiry banner and never call auth/refresh (jsdom)", async () => {
  for (const path of ["/sign-in/", "/work/"]) {
    const f = fixture(path), auth = f.siwe();
    const original = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, { window: f.dom.window, document: f.dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const manager = load("lib/auth/auth-refresh-manager.ts", { "./token-store": f.store,
      "./siwe": auth, "./auth-refresh-decisions.js": decisions }, f.globals);
    const hooks = load("lib/auth/use-auth.ts", { "./token-store": f.store, "./session-probe.js": probe }, f.globals);
    const { WalletSessionNotice } = load("components/auth/WalletSessionNotice.tsx", {
      "@/lib/auth/use-auth": hooks, "@/lib/auth/use-wallet-provider": { useWalletConnection: () => ({ status: "session_expired" }) },
      "@/lib/auth/wallet-provider.js": {}, "@/components/ui/button": { Button: ({ children }) => React.createElement("span", null, children) },
      "next/link": { default: ({ children }) => React.createElement("a", null, children) }
    }, f.globals);
    const container = f.dom.window.document.getElementById("root"), view = createRoot(container);
    let stop;
    try {
      assert.equal(f.dom.window.localStorage.length, 0);
      await act(async () => {
        view.render(React.createElement(WalletSessionNotice));
        stop = manager.startAuthRefreshManager();
        await auth.refreshAuthToken();
        f.dom.window.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.equal(f.calls.length, 0, path + ": no refresh request without a session");
      assert.equal(container.querySelector("[data-session-expiry]"), null);
      assert.doesNotMatch(container.textContent, /sign-in expired/);
      assert.equal(f.store.getAuthSnapshot().lastReason, undefined);
      f.store.clearSession("token_refresh_rejected");
      assert.equal(f.store.getAuthSnapshot().lastReason, undefined);
      assert.equal(f.dom.window.localStorage.getItem("averray:auth-last-reason"), null);
    } finally {
      stop?.();
      await act(async () => view.unmount());
      f.dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  }
});

test("a late refresh rejection after sign-out neither invents a banner nor clears a replacement session", async () => {
  for (const replace of [false, true]) {
    const f = fixture("/work/");
    try {
      const session = { token: "fixture", wallet: "wallet", expiresAt: "2099-01-01T00:00:00Z", roles: [] };
      f.store.writeSession(session);
      let release;
      const pending = f.siwe(() => new Promise((resolve) => { release = resolve; })).refreshAuthToken();
      f.store.clearSession();
      if (replace) f.store.writeSession({ ...session, token: "replacement" });
      release({ status: 401 });
      assert.equal((await pending).reason, "no_session");
      assert.equal(f.store.getAuthSnapshot().lastReason, undefined);
      assert.equal(f.store.getStoredToken(), replace ? "replacement" : undefined);
      assert.equal(f.dom.window.localStorage.getItem("averray:auth-last-reason"), null);
    } finally { f.dom.window.close(); }
  }
});
