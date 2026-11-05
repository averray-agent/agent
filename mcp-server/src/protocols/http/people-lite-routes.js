import { PEOPLE_LITE_BATCH_LIMIT, normalizePeopleWallet } from "../../core/people-lite.js";
import { ValidationError } from "../../core/errors.js";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Public read adapter. No auth, no claim check, no cap.
 * GET /people/personhood/:wallet
 * GET /people/personhood?wallets=0x…,0x…
 */
export function createPeopleLiteRoutes({ reader, respond }) {
  return async function handlePeopleLiteRoute({ request, response, url, pathname }) {
    if (request.method !== "GET") return false;
    if (pathname === "/people/personhood") {
      const wallets = parseWalletList(url.searchParams.get("wallets"));
      const body = await reader.readMany(wallets);
      respond(response, 200, body, NO_STORE);
      return true;
    }
    if (pathname.startsWith("/people/personhood/")) {
      const raw = decodeURIComponent(pathname.slice("/people/personhood/".length));
      if (!raw || raw.includes("/")) {
        throw new ValidationError("wallet path segment must be a 0x-prefixed 20-byte hex address.");
      }
      const wallet = normalizePeopleWallet(raw);
      if (!wallet) {
        throw new ValidationError("wallet path segment must be a 0x-prefixed 20-byte hex address.");
      }
      const body = await reader.read(wallet);
      const status = body.available === false ? 502 : 200;
      respond(response, status, body, NO_STORE);
      return true;
    }
    return false;
  };
}

function parseWalletList(raw) {
  const wallets = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (wallets.length === 0) {
    throw new ValidationError("wallets must list at least one 0x address.");
  }
  if (wallets.length > PEOPLE_LITE_BATCH_LIMIT) {
    throw new ValidationError(`wallets accepts at most ${PEOPLE_LITE_BATCH_LIMIT} addresses per pinned read.`);
  }
  const seen = new Set();
  const unique = [];
  for (const wallet of wallets) {
    const normalized = normalizePeopleWallet(wallet);
    if (!normalized) {
      throw new ValidationError("every wallets entry must be a 0x-prefixed 20-byte hex address.");
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}
