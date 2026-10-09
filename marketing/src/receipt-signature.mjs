import { verifyReceiptSignature } from "../../app/lib/ui/receipt-signature-verification.js";

// Uses the same browser-only canonical ES256 verifier as the operator app.
// The reader may finish before this deferred module loads; replay that document.
export function watchReceiptSignature(window) {
  const label = window.document.querySelector("[data-receipt-signature]");
  let revision = 0;
  async function refresh() {
    const document = window.AverrayReceiptDocument;
    if (!label || !document) return;
    const current = ++revision;
    label.textContent = "Checking signature…";
    const result = await verifyReceiptSignature({ document,
      fetchImpl: window.fetch?.bind(window), cryptoImpl: window.crypto,
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json"
    }).catch(() => ({ state: "unavailable" }));
    if (current !== revision) return;
    label.textContent = receiptSignatureLabel(result);
  }
  window.addEventListener("averray:receipt-ready", refresh);
  return refresh();
}

export function receiptSignatureLabel(result) {
  switch (result.state) {
    case "verified": return `Signed by ${result.kid} (${result.alg})`;
    case "unsigned": return "Not signed";
    case "failed": return "Signature invalid";
    default: return "Signature not checked (verification unavailable)";
  }
}
