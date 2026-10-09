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
  async function row(digit, date = "2026-10-09T10:00:00Z", overrides = {}) {
    const document = { schemaVersion: "averray.work-receipt.v1", kind: "run", receiptId: id(digit),
      verifier: { handler: "github_pr" }, verdict: { outcome: "approved" },
      settlement: { settlementTx: id("f") }, timestamps: { verifiedAt: date }, ...overrides };
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
  let pageOverride;
  let linked = null;
  let jwksOk = true;
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.ok(options.signal, "every public read has a deadline");
    if (url.includes("/.well-known/")) return { ok: jwksOk, json: async () => ({ keys: [jwk] }) };
    if (url.includes("/receipts/")) return { ok: true, json: async () => ({ schemaVersion: "averray.receipt-envelope.v1",
      document: linked ?? rows.find((r) => url.endsWith(r.document.receiptId)).document }) };
    assert.deepEqual(Object.fromEntries(new URL(url).searchParams), {
      handler: "github_pr", outcome: "approved", settled: "true", sort: "verifiedAt:desc", limit: "1"
    });
    const eligible = rows.filter(({ document: d }) => d.verifier.handler === "github_pr"
      && d.verdict.outcome === "approved" && /^0x[0-9a-f]{64}$/iu.test(d.settlement?.settlementTx))
      .sort((a, b) => Date.parse(b.document.timestamps.verifiedAt) - Date.parse(a.document.timestamps.verifiedAt));
    return { ok: true, json: async () => pageOverride ?? {
      items: eligible.slice(0, 1), nextCursor: eligible.length > 1 ? "more" : null
    } };
  };
  return { row, rows, calls, fetchImpl, setPage: (value) => { pageOverride = value; },
    setLinked: (value) => { linked = value; }, setJwksOk: (value) => { jwksOk = value; } };
}

test("latest receipt makes one filtered one-item query and browser-verifies the linked signed document", async () => {
  const h = await harness();
  h.rows[1].unsignedPresentation.issuedAt = "2099-01-01";
  h.rows[0].unsignedPresentation.issuedAt = "1999-01-01";
  h.rows.unshift(await h.row("3", "2026-10-09T11:59:00Z", { verifier: { handler: "benchmark" } }),
    await h.row("4", "2026-10-09T11:58:00Z", { verdict: { outcome: "rejected" } }),
    await h.row("5", "2026-10-09T11:57:00Z", { settlement: {} }));
  assert.deepEqual(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), {
    href: `/receipts/${id("1")}/`, date: "2026-10-09", signature: "Signed by badge-1 (ES256)" });
  assert.equal(h.calls.filter((url) => url.includes("/badges?")).length, 1);
  assert.equal(h.calls.length, 3, "only list, linked document and JWKS; never follow nextCursor");
  assert.ok(h.calls.some((url) => url.endsWith(`/receipts/${id("1")}`)));
});

for (const [name, date, overrides] of [
  ["stale", "2026-08-16T10:00:00Z", {}],
  ["future", "2026-10-10T10:00:00Z", {}],
  ["missing signed date", undefined, { timestamps: {} }],
  ["non-GitHub", undefined, { verifier: { handler: "benchmark" } }],
  ["rejected", undefined, { verdict: { outcome: "rejected" } }],
  ["unsettled", undefined, { settlement: {} }],
  ["non-hash settlement", undefined, { settlement: { settlementTx: "pending" } }],
  ["badge document", undefined, { kind: "badge" }]
]) test(`${name} candidate with matching signed linked document never claims latest`, async () => {
  const h = await harness();
  const candidate = await h.row("3", date, overrides);
  h.setPage({ items: [candidate], nextCursor: null });
  h.setLinked(candidate.document);
  assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null);
});

test("absent, malformed and failed reads never claim latest", async () => {
  const h = await harness();
  for (const page of [
    { items: [], nextCursor: null }, { items: [h.rows[0]] },
    { items: [{ ...h.rows[0], schemaVersion: "future" }], nextCursor: null },
    { items: [{ ...h.rows[0], unsignedPresentation: { kind: "badge" } }], nextCursor: null }
  ]) {
    h.setPage(page);
    h.setLinked(h.rows[0].document);
    assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null);
  }
  h.setPage(undefined);
  h.rows.splice(0, h.rows.length, await h.row("3", undefined, { verifier: { handler: "benchmark" } }));
  assert.equal(await latestReceipt({ ...h, cryptoImpl: webcrypto, now }), null, "filter has no matches");
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
