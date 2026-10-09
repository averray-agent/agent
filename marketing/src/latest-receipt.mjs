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

// V3b filters before limiting and orders by the signed verifiedAt timestamp.
export async function latestReceipt({ fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
  now = Date.now(), signal = AbortSignal.timeout(10000) } = {}) {
  async function read(path) {
    const response = await fetchImpl(API + path, { signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Receipt read unavailable");
    return response.json();
  }
  try {
    const page = await read("/badges?handler=github_pr&outcome=approved&settled=true&sort=verifiedAt:desc&limit=1");
    if (!Array.isArray(page?.items) || page.items.length !== 1
      || !(page.nextCursor === null || typeof page.nextCursor === "string")) return null;
    const row = page.items[0];
    if (row?.schemaVersion !== "averray.badge-list-item.v1"
      || row.unsignedPresentation?.kind !== "run" || !settledGithubRun(row.document)) return null;
    const newest = { document: row.document, issuedAt: Date.parse(row.document.timestamps?.verifiedAt) };
    if (!Number.isFinite(newest.issuedAt) || newest.issuedAt > now || now - newest.issuedAt > WEEK_MS) return null;
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
