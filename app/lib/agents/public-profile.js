/**
 * Public agent-profile URL builder — the bridge from the operator app's
 * agents directory to the public profile page.
 *
 * The public page is served at `averray.com/agents/<wallet>`. The Caddy
 * rewrite in `deploy/Caddyfile.averray` matches
 * `^/agents/(0x[a-fA-F0-9]{40})/?$` and serves the static `agent.html`
 * shell, which hydrates from `GET https://api.averray.com/agents/<wallet>`
 * — the SAME public API the internal directory row reads. So the public
 * profile renders the same reputation/badge data by construction.
 *
 * TRUTH-BOUNDARY: returns `null` for anything that is not a `0x`+40-hex
 * address, so the app never emits a link the Caddy rewrite won't match
 * (which would land on the site 404, not a profile). The wallet is
 * lowercased to the canonical form the profile shell and API use.
 */

/** Public site origin that serves agent profiles. */
export const PUBLIC_SITE_BASE = "https://averray.com";

/**
 * Mirrors the Caddy `@agentProfile` rewrite matcher. Kept here so the
 * builder and its tests assert against the exact deployed contract.
 */
export const PUBLIC_PROFILE_WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/u;

/**
 * Build the canonical public profile URL for a wallet.
 * @param {unknown} walletFull full EVM address (any case)
 * @returns {string | null} `https://averray.com/agents/<lowercased>` or
 *   `null` when the value is not a valid EVM address.
 */
export function publicProfileUrl(walletFull) {
  if (typeof walletFull !== "string") return null;
  const wallet = walletFull.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(wallet)) return null;
  return `${PUBLIC_SITE_BASE}/agents/${wallet}`;
}
