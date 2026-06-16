// Redact credential-looking material from provider/RPC error strings before
// they reach operator-visible surfaces (the gateway health endpoint and the
// system.* event stream) — pre-audit #8.
//
// Raw ethers/provider errors frequently echo the configured RPC endpoint
// verbatim, and many hosted providers (Infura, Alchemy, dwellir paid tiers,
// …) carry the API key in the URL path or query — so a single reconnect
// error can publish the signing-tier RPC key to anyone watching /health or
// the event stream. Errors can likewise echo Authorization headers, JWTs, or
// `apikey=`-style params from a request body.
//
// The redaction is deliberately narrow: it strips URL userinfo/path/query
// (keeping scheme://host so operators still see *which* provider failed),
// credential key=value params, Bearer tokens, and JWTs. It leaves revert
// reasons, "insufficient funds"/"nonce" diagnostics, on-chain addresses, and
// tx hashes intact so error classification and debugging are unaffected.

// scheme://[userinfo@]host[:port][/path?query#frag] → scheme://host[/[redacted]]
const URL_RE = /\b(https?|wss?):\/\/(?:[^\s/@'"]+@)?([^\s/:'"]+(?::\d+)?)(\/[^\s'"]*)?/gi;

// key=value / key: value where the key names a credential. Keeps the key name
// and delimiter; redacts only the value.
const SECRET_PARAM_RE =
  /\b(api[_-]?key|apikey|token|secret|password|passwd|access[_-]?key|private[_-]?key)\b(\s*[=:]\s*)("?)([^&\s'"]+)\3/gi;

// Authorization: Bearer <token>
const BEARER_RE = /\b(Bearer)\s+([A-Za-z0-9._~+/=-]+)/gi;

// JSON Web Tokens always begin with the base64url of `{"` → "eyJ".
const JWT_RE = /\beyJ[A-Za-z0-9._-]{8,}/g;

/**
 * Redact credential-looking substrings from a provider error string.
 * Non-string input is coerced (objects via their `message`/`reason` field
 * when present, else String()), so callers can hand it a raw error.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function redactProviderError(input) {
  let text;
  if (typeof input === "string") {
    text = input;
  } else if (input && typeof input === "object") {
    text = String(input.message ?? input.reason ?? input);
  } else {
    text = String(input ?? "");
  }

  return text
    .replace(URL_RE, (_match, scheme, host, rest) => `${scheme}://${host}${rest ? "/[redacted]" : ""}`)
    .replace(SECRET_PARAM_RE, (_match, key, delim) => `${key}${delim}[redacted]`)
    .replace(BEARER_RE, (_match, scheme) => `${scheme} [redacted]`)
    .replace(JWT_RE, "[redacted-jwt]");
}
