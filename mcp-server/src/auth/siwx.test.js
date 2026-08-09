import assert from "node:assert/strict";
import test from "node:test";

import { Wallet, id } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import { SiwxAuthAdapter, buildSiwxEip4361Message } from "./siwx.js";

const ORIGIN = "https://api.example.test";
const PATH = "/jobs/x402";
const BINDING = id("job-body");
const NOW = new Date("2026-08-09T12:00:00.000Z");

function adapter(store = new MemoryStateStore()) {
  return new SiwxAuthAdapter({
    stateStore: store,
    publicOrigin: ORIGIN,
    chainId: "eip155:8453",
    nonceTtlSeconds: 300,
    now: () => NOW,
    randomBytesImpl: () => Buffer.from("0123456789abcdef")
  });
}

async function signedHeader(auth, wallet, challenge, overrides = {}) {
  const proof = {
    ...challenge.info,
    address: wallet.address,
    chainId: "eip155:8453",
    type: "eip191",
    ...overrides
  };
  proof.signature = await wallet.signMessage(buildSiwxEip4361Message(proof));
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

test("SIWX verifies the EIP-4361 header and consumes its body-bound nonce once", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const challenge = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });
  const header = await signedHeader(auth, wallet, challenge);

  const verified = await auth.verifyHeader(header, {
    resourcePath: PATH,
    requestBinding: BINDING
  });
  assert.equal(verified.wallet, wallet.address.toLowerCase());

  await assert.rejects(
    auth.verifyHeader(header, { resourcePath: PATH, requestBinding: BINDING }),
    (error) => error.code === "invalid_siwx_nonce"
  );
});

test("SIWX refuses origin substitution even when the attacker signs the changed message", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const challenge = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });
  const header = await signedHeader(auth, wallet, challenge, {
    domain: "evil.example",
    uri: "https://evil.example/jobs/x402",
    resources: ["https://evil.example/jobs/x402"]
  });

  await assert.rejects(
    auth.verifyHeader(header, { resourcePath: PATH, requestBinding: BINDING }),
    (error) => error.code === "invalid_siwx_domain_mismatch"
  );
});

test("SIWX refuses a valid challenge replayed with different job content", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const challenge = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });
  const header = await signedHeader(auth, wallet, challenge);

  await assert.rejects(
    auth.verifyHeader(header, { resourcePath: PATH, requestBinding: id("different-body") }),
    (error) => error.code === "invalid_siwx_nonce_binding"
  );
});

test("SIWX requires the exact issued EIP-4361 message rather than only a valid nonce", async () => {
  const auth = adapter();
  const wallet = Wallet.createRandom();
  const challenge = await auth.issueChallenge({ resourcePath: PATH, requestBinding: BINDING });
  const header = await signedHeader(auth, wallet, challenge, {
    statement: "A different statement signed by the same wallet."
  });

  await assert.rejects(
    auth.verifyHeader(header, { resourcePath: PATH, requestBinding: BINDING }),
    (error) => error.code === "invalid_siwx_challenge_mutated"
  );
});
