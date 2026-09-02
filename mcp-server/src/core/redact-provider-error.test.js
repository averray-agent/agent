import test from "node:test";
import assert from "node:assert/strict";

import { redactProviderError } from "./redact-provider-error.js";

test("strips the path/query of an RPC URL but keeps scheme://host (pre-audit #8)", () => {
  const out = redactProviderError("could not detect network (https://eth.example.io/v3/SUPERSECRETKEY123)");
  assert.match(out, /https:\/\/eth\.example\.io\/\[redacted\]/);
  assert.doesNotMatch(out, /SUPERSECRETKEY123/);
});

test("redacts a wss endpoint key and any userinfo", () => {
  const out = redactProviderError("ws closed wss://user:pass@asset-hub.n.dwellir.com/abcd-key-1234");
  assert.doesNotMatch(out, /abcd-key-1234/);
  assert.doesNotMatch(out, /user:pass/);
  assert.match(out, /wss:\/\/asset-hub\.n\.dwellir\.com\/\[redacted\]/);
});

test("redacts credential key=value params anywhere", () => {
  const out = redactProviderError("request failed apikey=deadbeefcafe token: hunter2secret");
  assert.match(out, /apikey=\[redacted\]/);
  assert.match(out, /token:\s*\[redacted\]/);
  assert.doesNotMatch(out, /deadbeefcafe/);
  assert.doesNotMatch(out, /hunter2secret/);
});

test("redacts Bearer tokens and JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.signaturepart";
  const out = redactProviderError(`401 Authorization: Bearer ${jwt}`);
  assert.match(out, /Bearer \[redacted\]/);
  assert.doesNotMatch(out, /signaturepart/);
});

test("leaves revert reasons, addresses, and tx hashes intact", () => {
  const msg =
    "execution reverted: insufficient funds (nonce too low) job 0x" +
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
    " from 0x6778F050eAc8313e4dbB176d7BAB44510E833ac8";
  const out = redactProviderError(msg);
  assert.equal(out, msg, "diagnostic + on-chain data must survive unredacted");
});

test("coerces a raw error object via its message", () => {
  const out = redactProviderError(new Error("boom https://rpc.example.io/key/SECRET"));
  assert.match(out, /https:\/\/rpc\.example\.io\/\[redacted\]/);
  assert.doesNotMatch(out, /SECRET/);
});
