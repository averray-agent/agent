// Heuristics for "this looks like a raw secret pasted into an env template".
// Not exhaustive — callers should still review by eye.
const RAW_SECRET_HEURISTICS = [
  {
    name: 'hex private key (32+ bytes)',
    re: /=[\s]*0x[a-fA-F0-9]{60,}[\s]*$/m,
    accountId32FalsePositive: true,
  },
  {
    name: 'JWT',
    re: /=[\s]*ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/m,
  },
  {
    name: 'long base64-ish secret',
    re: /=[\s]*[A-Za-z0-9+/=]{60,}[\s]*$/m,
    accountId32FalsePositive: true,
  },
  {
    name: 'API-key prefix',
    re: /=[\s]*(sk_live_|sk_test_|re_|pk_live_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/m,
  },
];

const ACCOUNT_ID32_KEY_RE = /ACCOUNT_ID32$/u;
const ACCOUNT_ID32_VALUE_RE = /^0x[a-fA-F0-9]{64}$/u;

/**
 * Return the raw-secret heuristic names matched by one template line.
 *
 * A Substrate AccountId32 is a public identifier with the same lexical shape
 * as an EVM private key. Exempt only an ACCOUNT_ID32-suffixed assignment whose
 * value is exactly one 32-byte hex identifier; other values and key names keep
 * every existing secret check.
 */
export function findRawSecretHeuristics(line, { varName, value } = {}) {
  const publicAccountId32 = ACCOUNT_ID32_KEY_RE.test(String(varName ?? ''))
    && ACCOUNT_ID32_VALUE_RE.test(String(value ?? '').trim());
  return RAW_SECRET_HEURISTICS
    .filter(({ accountId32FalsePositive }) => !(publicAccountId32 && accountId32FalsePositive))
    .filter(({ re }) => re.test(line))
    .map(({ name }) => name);
}
