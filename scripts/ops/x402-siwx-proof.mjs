/**
 * Turning a 402 sign-in challenge into the fields a payer signs.
 *
 * This lives in its own module, apart from the client script, for one reason:
 * the client script cannot be imported by a test without reading a private key
 * and calling production. Pulled out here, the mapping can be held directly
 * against the server's own SiwxAuthAdapter — which is the only check that
 * matters, because the two halves already drifted twice.
 *
 *   1. The client looked for `envelope.signIn`. The server emits the challenge
 *      as an x402 extension keyed by the header name, `sign-in-with-x`.
 *   2. The client then omitted `address` altogether, which is one of the three
 *      fields the server cannot fill in for us.
 *
 * Both failures cost a live round trip against production to discover.
 */

/** The extension key the ramp emits the challenge under. */
export const SIWX_EXTENSION_KEY = "sign-in-with-x";

/**
 * Pull the sign-in challenge out of a 402 envelope.
 * Returns undefined rather than throwing, so callers can report the envelope
 * they actually got instead of a bare "missing" — a wrong key looks identical
 * to a disabled ramp otherwise.
 */
export function readSignInChallenge(envelope) {
  return envelope?.extensions?.[SIWX_EXTENSION_KEY];
}

/**
 * Build the EIP-4361 proof fields to sign.
 *
 * The server stores the challenge fields it issued and compares them, field for
 * field, against what comes back. So `info` is spread through untouched and only
 * the three fields the server cannot know are added: which wallet signs, and
 * which of the advertised chains it signs on.
 */
export function buildSiwxProofFields(signIn, address) {
  const chain = signIn?.supportedChains?.[0] ?? {};
  return {
    ...signIn?.info,
    address,
    chainId: String(chain.chainId ?? ""),
    type: String(chain.type ?? "eip191")
  };
}
