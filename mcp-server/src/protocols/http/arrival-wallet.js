/**
 * An arrival wallet is a subject the auth middleware verified on a route
 * other than POST /auth/nonce.
 *
 * The nonce body is an unsigned claim. Passing it into the observatory links
 * the caller's client name to that address, so a later anonymous request with
 * the same client name is counted as that wallet — including a registered
 * self wallet. Alerts then treat the caller as authenticated.
 */
export function verifiedArrivalWallet(pathname, request) {
  if (pathname === "/auth/nonce") return undefined;
  const wallet = request?._arrivalWallet;
  return typeof wallet === "string" && wallet ? wallet : undefined;
}
