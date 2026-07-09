/**
 * @param {unknown} value
 * @param {Record<string, unknown> | null} [averray]
 */
export function extractReceiptSigners(value, averray = null) {
  if (Array.isArray(value)) {
    const signers = value
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry;
        const address = text(record.address, text(record.wallet, ""));
        const role = text(record.role, "") || signerRole(record.status, index);
        const signedAt = text(
          record.signedAt,
          text(record.signed_at, text(record.timestamp, text(record.at, "")))
        );
        return signer(address, role, toneForRole(role), signedAt);
      })
      .filter(Boolean);
    if (signers.length) return signers;
  }

  return [
    signer(text(averray?.poster, ""), "operator", "sage"),
    signer(text(averray?.verifier, ""), "verifier", "blue"),
    signer(text(averray?.worker, ""), "worker", "ink"),
  ].filter((entry) => entry.identified);
}

function signer(address, role, tone, signedAt = "") {
  const identified = isIdentifiedSignerAddress(address);
  return {
    initials: identified ? initials(role || address) : "?",
    tone: identified ? tone : "muted",
    role,
    address: identified ? shortAddress(address) : "",
    identified,
    ...(signedAt ? { signedAt: displayTime(signedAt) } : {}),
  };
}

function signerRole(status, index) {
  const raw = text(status, "");
  if (raw === "posted") return "operator";
  if (raw === "signed") return index === 0 ? "operator" : "verifier";
  return raw || (index === 0 ? "operator" : "cosigner");
}

function toneForRole(role) {
  if (role === "operator") return "sage";
  if (role === "verifier") return "blue";
  if (role === "worker") return "ink";
  if (role === "cosigner") return "clay";
  return "muted";
}

function displayTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value || "pending";
  const date = new Date(parsed);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

function text(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : fallback;
}

function shortAddress(value) {
  if (!value.startsWith("0x") || value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function isIdentifiedSignerAddress(value) {
  const raw = value.trim();
  return /^0x[0-9a-fA-F]{40}$/u.test(raw) && !/^0x0{40}$/iu.test(raw);
}

function initials(value) {
  return (value.match(/[a-z0-9]/giu)?.join("") ?? "--").slice(0, 1).toUpperCase();
}
