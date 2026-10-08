import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import canonicalize from "canonicalize";
import { watchReceiptSignature } from "../../marketing/src/receipt-signature.mjs";

const reader = readFileSync(new URL("../../marketing/public/receipt-reader.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../../marketing/src/components/ReceiptPage.astro", import.meta.url), "utf8");
const id = "0x" + "8".repeat(64);
const unsigned = { receiptId: id, verdict: { outcome: "approved" } };

async function signedFixture() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...await webcrypto.subtle.exportKey("jwk", keys.publicKey), alg: "ES256", kid: "badge-1", use: "sig" };
  const header = { alg: "ES256", kid: "badge-1", signedAt: "2026-10-08T12:00:00Z", typ: "averray-badge-receipt+jws" };
  const protectedPart = Buffer.from(canonicalize(header)).toString("base64url");
  const input = new TextEncoder().encode(protectedPart + "." + Buffer.from(canonicalize(unsigned)).toString("base64url"));
  const bytes = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, input);
  return { jwk, document: { ...unsigned, signature: { alg: header.alg, kid: header.kid, signedAt: header.signedAt,
    sig: protectedPart + ".." + Buffer.from(bytes).toString("base64url") } } };
}

test("public reader labels only a browser-verified document signed, including late module loading", async () => {
  assert.match(page, /watchReceiptSignature\(window\)/u, "built page invokes browser verifier");
  const fixture = await signedFixture();
  for (const late of [false, true]) {
    for (const [document, jwksAvailable, expected] of [
      [unsigned, true, "Not signed"],
      [fixture.document, true, "Signed by badge-1 (ES256)"],
      [{ ...fixture.document, receiptId: "tampered" }, true, "Not signed"],
      [fixture.document, false, "Not signed"]
    ]) {
      const dom = new JSDOM('<div data-receipt-state><p data-receipt-status></p><p data-receipt-signature></p><div data-receipt><pre data-receipt-json></pre><div data-settlement></div></div></div>',
        { url: "https://averray.com/receipts/" + id + "/", runScripts: "outside-only" });
      const { window } = dom;
      Object.defineProperty(window, "crypto", { value: webcrypto });
      window.fetch = async (url) => {
        assert.equal(url, "https://api.averray.com/.well-known/badge-receipt-jwks.json");
        return { ok: jwksAvailable, status: jwksAvailable ? 200 : 503, json: async () => ({ keys: [fixture.jwk] }) };
      };
      window.AverrayReaderFetch = { readJsonWithRetry: async () => document };
      if (!late) await watchReceiptSignature(window);
      window.eval(reader);
      await new Promise((resolve) => setImmediate(resolve));
      if (late) await watchReceiptSignature(window);
      const label = window.document.querySelector("[data-receipt-signature]");
      for (let n = 0; n < 100 && !["Not signed", "Signed by badge-1 (ES256)"].includes(label.textContent); n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(label.textContent, expected);
      assert.equal(window.document.querySelector("[data-receipt-state]").dataset.receiptState, "ready");
      assert.deepEqual(JSON.parse(window.document.querySelector("[data-receipt-json]").textContent), document);
      window.close();
    }
  }
});
