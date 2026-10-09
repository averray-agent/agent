import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import canonicalize from "canonicalize";
import { JSDOM } from "jsdom";
import { latestReceipt, showLatestReceipt } from "../../marketing/src/latest-receipt.mjs";

const now = Date.parse("2026-10-09T12:00:00Z");
const id = (digit) => "0x" + digit.repeat(64);
async function harness() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...await webcrypto.subtle.exportKey("jwk", keys.publicKey), alg: "ES256", kid: "badge-1", use: "sig" };
  async function row(digit, date = "2026-10-09T10:00:00Z") {
    const document = { schemaVersion: "averray.work-receipt.v1", kind: "run", receiptId: id(digit),
      verifier: { handler: "github_pr" }, verdict: { outcome: "approved" },
      settlement: { settlementTx: id("f") }, timestamps: { verifiedAt: date } };
    const header = { alg: "ES256", kid: "badge-1", signedAt: date, typ: "averray-badge-receipt+jws" };
    const protectedPart = Buffer.from(canonicalize(header)).toString("base64url");
    const input = new TextEncoder().encode(protectedPart + "." + Buffer.from(canonicalize(document)).toString("base64url"));
    const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, input);
    document.signature = { alg: header.alg, kid: header.kid, signedAt: date,
      sig: protectedPart + ".." + Buffer.from(signature).toString("base64url") };
    return { schemaVersion: "averray.badge-list-item.v1", document,
      unsignedPresentation: { kind: "run", issuedAt: date } };
  }
  const calls = [];
  const rows = [await row("1"), await row("2", "2026-10-08T10:00:00Z")];
  let pages = [{ items: rows, nextCursor: null }];
  let linked = null;
  let jwksOk = true;
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.ok(options.signal, "every public read has a deadline");
    if (url.includes("/.well-known/")) return { ok: jwksOk, json: async () => ({ keys: [jwk] }) };
    if (url.includes("/receipts/")) return { ok: true, json: async () => ({ schemaVersion: "averray.receipt-envelope.v1",
      document: linked ?? rows.find((r) => url.endsWith(r.document.receiptId)).document }) };
    return { ok: true, json: async () => pages[url.includes("cursor=") ? 1 : 0] };
  };
  return { row, rows, calls, fetchImpl, setPages: (value) => { pages = value; },
    setLinked: (value) => { linked = value; }, setJwksOk: (value) => { jwksOk = value; } };
}

test("latest receipt walks served envelopes, sorts signed dates, and verifies the linked document", async () => {
  const h = await harness();
  h.rows[1].unsignedPresentation.issuedAt = "2099-01-01";
  h.setPages([{ items: [h.rows[1], { ...h.rows[0], unsignedPresentation: { kind: "badge" } }], nextCursor: "next/page" },
    { items: [h.rows[0]], nextCursor: null }]);
  assert.deepEqual(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), {
    href: `/receipts/${id("1")}/`, date: "2026-10-09", signature: "Signed by badge-1 (ES256)" });
  assert.ok(h.calls.some((url) => url.endsWith("cursor=next%2Fpage")));
  assert.ok(h.calls.some((url) => url.endsWith(`/receipts/${id("1")}`)));
});

test("stale, absent, non-GitHub, unsettled, incomplete and failed reads never claim latest", async () => {
  const h = await harness();
  const stale = await h.row("3", "2026-08-16T10:00:00Z");
  for (const page of [
    { items: [stale], nextCursor: null }, { items: [], nextCursor: null },
    { items: [{ ...h.rows[0], document: { ...h.rows[0].document, verifier: { handler: "verify" } } }], nextCursor: null },
    { items: [{ ...h.rows[0], document: { ...h.rows[0].document, settlement: undefined } }], nextCursor: null },
    { items: h.rows, nextCursor: "loop" }, { items: h.rows },
    { items: [{ schemaVersion: "future" }], nextCursor: null }
  ]) {
    h.setPages([page, page]);
    h.setLinked(stale.document);
    assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null);
  }
  assert.equal(await latestReceipt({ fetchImpl: async () => { throw new Error("offline"); }, now }), null);
});

test("unsigned, tampered, wrong linked receipt and unavailable JWKS fall back honestly", async () => {
  const h = await harness();
  for (const linked of [
    { ...h.rows[0].document, signature: undefined },
    { ...h.rows[0].document, jobId: "tampered" }, h.rows[1].document
  ]) {
    h.setLinked(linked);
    assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null);
  }
  h.setLinked(null);
  h.setJwksOk(false);
  assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null);
});

test("both marketing consumers render a verified recent link or a dated example on read failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const component = readFileSync(new URL("../../marketing/src/components/LatestReceipt.astro", import.meta.url), "utf8");
  for (const file of ["pages/index.astro", "components/ReceiptPage.astro"]) {
    const consumer = readFileSync(new URL(`../../marketing/src/${file}`, import.meta.url), "utf8");
    assert.match(consumer, /<LatestReceipt\s*\/>/u);
  }
  assert.match(component, /showLatestReceipt\(window\)/u);
  const dom = new JSDOM(component.replace(/<script>[\s\S]*?<\/script>/gu, ""));
  dom.window.fetch = async () => { throw new Error("offline"); };
  const before = dom.window.document.querySelector("[data-latest-link]").getAttribute("href");
  await showLatestReceipt(dom.window);
  assert.equal(dom.window.document.querySelector("[data-latest-link]").getAttribute("href"), before);
  assert.match(dom.window.document.querySelector("[data-latest-link]").textContent, /Example.*2026-08-16/u);
  assert.match(dom.window.document.querySelector("[data-latest-status]").textContent, /dated example, not the latest/u);
  const h = await harness();
  dom.window.fetch = h.fetchImpl;
  Object.defineProperty(dom.window, "crypto", { value: webcrypto });
  await showLatestReceipt(dom.window);
  assert.equal(dom.window.document.querySelector("[data-latest-link]").getAttribute("href"), `/receipts/${id("1")}/`);
  assert.equal(dom.window.document.querySelector("[data-latest-link]").textContent, "Latest settled GitHub PR receipt — 2026-10-09");
  assert.equal(dom.window.document.querySelector("[data-latest-status]").textContent, "Signed by badge-1 (ES256)");
  dom.window.close();
});
