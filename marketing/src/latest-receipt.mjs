import { verifyReceiptSignature } from "../../app/lib/ui/receipt-signature-verification.js";
import { receiptSignatureLabel } from "./receipt-signature.mjs";

const API = "https://api.averray.com";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HASH = /^0x[0-9a-f]{64}$/iu;

function settledGithubRun(document) {
  return document?.schemaVersion === "averray.work-receipt.v1"
    && document.kind === "run" && document.verifier?.handler === "github_pr"
    && document.verdict?.outcome === "approved"
    && HASH.test(document.receiptId) && HASH.test(document.settlement?.settlementTx);
}

// /badges pages are session-ordered, not globally receipt-date-ordered. Finish
// the bounded walk before claiming "latest"; a partial walk is not evidence.
export async function latestReceipt({ fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
  now = Date.now(), signal = AbortSignal.timeout(10000) } = {}) {
  async function read(path) {
    const response = await fetchImpl(API + path, { signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Receipt read unavailable");
    return response.json();
  }
  try {
    let cursor = null;
    let newest = null;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = await read(`/badges?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page?.items) || !(page.nextCursor === null || typeof page.nextCursor === "string")) return null;
      for (const row of page.items) {
        if (row?.schemaVersion !== "averray.badge-list-item.v1") return null;
        const document = row.document;
        if (row.unsignedPresentation?.kind !== "run" || !settledGithubRun(document)) continue;
        // Use the signed timestamp, not the unsigned presentation's date.
        const issuedAt = Date.parse(document.timestamps?.verifiedAt);
        if (Number.isFinite(issuedAt) && issuedAt <= now && (!newest || issuedAt > newest.issuedAt)) newest = { document, issuedAt };
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      if (seen.has(cursor)) return null;
      seen.add(cursor);
    }
    if (cursor || !newest || now - newest.issuedAt > WEEK_MS) return null;
    // Verify the exact linked document, not just its listing wrapper.
    const response = await read(`/receipts/${newest.document.receiptId}`);
    const document = response?.schemaVersion === "averray.receipt-envelope.v1" ? response.document : response;
    if (!settledGithubRun(document) || document.receiptId !== newest.document.receiptId
      || Date.parse(document.timestamps?.verifiedAt) !== newest.issuedAt) return null;
    const verification = await verifyReceiptSignature({ document, cryptoImpl,
      fetchImpl: (url, options) => fetchImpl(url, { ...options, signal }),
      jwksUrl: API + "/.well-known/badge-receipt-jwks.json" });
    if (verification.state !== "verified") return null;
    return { href: `/receipts/${document.receiptId}/`, date: new Date(newest.issuedAt).toISOString().slice(0, 10),
      signature: receiptSignatureLabel(verification) };
  } catch {
    return null;
  }
}

export async function showLatestReceipt(window) {
  const cards = window.document.querySelectorAll("[data-latest-receipt]");
  if (!cards.length) return;
  const result = await latestReceipt({ fetchImpl: window.fetch.bind(window), cryptoImpl: window.crypto });
  for (const card of cards) {
    const status = card.querySelector("[data-latest-status]");
    if (!result) {
      status.textContent = "No verified recent settlement available from this read. Showing a dated example, not the latest receipt.";
      continue;
    }
    const link = card.querySelector("[data-latest-link]");
    link.href = result.href;
    link.textContent = `Latest settled GitHub PR receipt — ${result.date}`;
    status.textContent = result.signature;
  }
}
