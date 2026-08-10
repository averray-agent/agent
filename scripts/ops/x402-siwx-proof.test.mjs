import assert from "node:assert/strict";
import test from "node:test";

import { Wallet, id } from "ethers";

import { MemoryStateStore } from "../../mcp-server/src/core/state-store.js";
import { SiwxAuthAdapter, buildSiwxEip4361Message } from "../../mcp-server/src/auth/siwx.js";

import { SIWX_EXTENSION_KEY, buildSiwxProofFields, readSignInChallenge } from "./x402-siwx-proof.mjs";

const ORIGIN = "https://api.example.test";
const PATH = "/jobs/x402";
const BINDING = id("job-body");

function adapter() {
  return new SiwxAuthAdapter({
    stateStore: new MemoryStateStore(),
    publicOrigin: ORIGIN,
    chainId: "eip155:8453",
    nonceTtlSeconds: 300
  });
}

// The ramp's own paymentEnvelope shape, reduced to the part the client reads.
// Keyed by SIWX_EXTENSION_KEY so a rename on either side breaks this test.
function envelopeAround(signIn) {
  return {
    x402Version: 2,
    accepts: [{ scheme: "exact" }],
    extensions: { bazaar: {}, [SIWX_EXTENSION_KEY]: signIn }
  };
}

// The whole point. A challenge issued by the real adapter, signed by the fields
// this module builds, must verify against that same adapter. Nothing else the
// client does is worth testing; this is where it broke, twice.
test("a challenge from the real adapter round-trips through the client's proof fields", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const signIn = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });

  const proof = buildSiwxProofFields(readSignInChallenge(envelopeAround(signIn)), wallet.address);
  proof.signature = await wallet.signMessage(buildSiwxEip4361Message(proof));

  const verified = await auth.verifyHeader(
    Buffer.from(JSON.stringify(proof)).toString("base64"),
    { resourcePath: PATH, requestBinding: BINDING }
  );
  assert.equal(verified.wallet, wallet.address.toLowerCase());
});

// The first bug: reading the wrong key returned undefined, and the client's
// error said "no sign-in challenge" — indistinguishable from a ramp that is
// switched off. Pin the key so the mistake cannot be repeated silently.
test("the challenge is read from the extension key the ramp emits", () => {
  assert.equal(SIWX_EXTENSION_KEY, "sign-in-with-x");
  assert.equal(readSignInChallenge({ extensions: { signIn: { info: {} } } }), undefined);
  assert.deepEqual(readSignInChallenge(envelopeAround({ info: { domain: "x" } })), {
    info: { domain: "x" }
  });
});

// The second bug: `address` is one of exactly three fields the server cannot
// supply, and leaving it out failed inside ethers rather than anywhere legible.
test("the payer supplies address, chainId and type — and nothing else", async () => {
  const auth = adapter();
  const signIn = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });
  const proof = buildSiwxProofFields(signIn, "0x1013E3fe3F6dEb4E61DC023Ff69D420DD9Ce8F9f");

  assert.equal(proof.address, "0x1013E3fe3F6dEb4E61DC023Ff69D420DD9Ce8F9f");
  assert.equal(proof.chainId, "eip155:8453");
  assert.equal(proof.type, "eip191");

  const added = new Set(["address", "chainId", "type"]);
  const carried = Object.keys(proof).filter((key) => !added.has(key));
  assert.deepEqual(carried.sort(), Object.keys(signIn.info).sort());
  for (const key of carried) assert.deepEqual(proof[key], signIn.info[key]);
});

// Editing any issued field is rejected by design, so a client that "helpfully"
// normalises one would fail in production and nowhere else.
test("altering an issued field is refused by the server", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const signIn = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });

  const proof = buildSiwxProofFields(signIn, wallet.address);
  proof.statement = `${proof.statement} (edited)`;
  proof.signature = await wallet.signMessage(buildSiwxEip4361Message(proof));

  await assert.rejects(
    auth.verifyHeader(Buffer.from(JSON.stringify(proof)).toString("base64"), {
      resourcePath: PATH,
      requestBinding: BINDING
    }),
    (error) => error.code === "invalid_siwx_challenge_mutated"
  );
});
