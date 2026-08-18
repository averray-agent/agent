import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TypedDataEncoder, Wallet } from "ethers";

import {
  X402VerificationPaymentGate,
  createConfiguredX402VerificationPaymentGate,
  resolveX402VerificationPaymentConfig
} from "./x402-verification-payment-gate.js";

const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1013E3fe3F6dEb4E61DC023Ff69D420DD9Ce8F9f";
const TX = `0x${"a".repeat(64)}`;
const NOW = new Date("2026-08-18T12:00:00.000Z");
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));
const PROFILE = "git-patch-tests-v1@1";
const PROFILE_LIMITS = Object.freeze({ timeoutMs: 120_000 });
const REQUEST_HASH = `0x${"b".repeat(64)}`;
const PRICE = Object.freeze({ amountRaw: "5000000", asset: "USDC" });
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};

function config(overrides = {}) {
  return {
    enabled: true,
    mode: "enabled",
    network: "eip155:8453",
    chainId: 8453,
    rpcUrl: "https://base.example.test",
    asset: ASSET.toLowerCase(),
    payTo: PAY_TO.toLowerCase(),
    assetEip712Name: "USD Coin",
    assetEip712Version: "2",
    publicOrigin: "https://api.example.test",
    captureMarginSeconds: 600,
    ...overrides
  };
}

function domain(name = "USD Coin") {
  return { name, version: "2", chainId: 8453, verifyingContract: ASSET };
}

function harness({ nonceUsed = false, tokenName = "USD Coin", domainFailures = 0 } = {}) {
  const calls = { authorizationState: 0, capture: 0, wait: 0 };
  const tokenContract = {
    async name() { return tokenName; },
    async DOMAIN_SEPARATOR() {
      if (domainFailures > 0) {
        domainFailures -= 1;
        throw new Error("Base read unavailable");
      }
      return TypedDataEncoder.hashDomain(domain(tokenName));
    },
    async authorizationState() {
      calls.authorizationState += 1;
      return nonceUsed;
    }
  };
  const captureTokenContract = {
    async transferWithAuthorization(...args) {
      calls.capture += 1;
      calls.captureArgs = args;
      return {
        hash: TX,
        async wait() {
          calls.wait += 1;
          return { status: 1 };
        }
      };
    }
  };
  const gate = new X402VerificationPaymentGate({
    config: config(),
    provider: { async getNetwork() { return { chainId: 8453n }; } },
    tokenContract,
    captureTokenContract,
    now: () => NOW
  });
  return { calls, gate };
}

async function signedPayment(gate, {
  wallet = Wallet.createRandom(),
  value = PRICE.amountRaw,
  validAfter = NOW_SECONDS - 1n,
  validBefore = NOW_SECONDS + 721n,
  signingName = "USD Coin",
  nonce = `0x${"c".repeat(64)}`
} = {}) {
  const liveDomain = await gate.eip712Domain();
  const requirements = gate.paymentRequirements({
    domain: liveDomain,
    price: PRICE,
    profile: PROFILE,
    profileLimits: PROFILE_LIMITS,
    requestHash: REQUEST_HASH
  });
  const authorization = {
    from: wallet.address,
    to: requirements.payTo,
    value: String(value),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce
  };
  const signature = await wallet.signTypedData(domain(signingName), TYPES, authorization);
  return {
    paymentProof: Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: requirements,
      payload: { authorization, signature }
    })).toString("base64"),
    requirements
  };
}

async function authorize(gate, paymentProof) {
  return gate.authorize({
    paymentProof,
    price: PRICE,
    profile: PROFILE,
    profileLimits: PROFILE_LIMITS,
    requestHash: REQUEST_HASH
  });
}

test("authorize verifies EIP-3009 offline and capture alone submits transferWithAuthorization", async () => {
  const { calls, gate } = harness();
  const { paymentProof } = await signedPayment(gate);
  const authorization = await authorize(gate, paymentProof);

  assert.equal(authorization.amountRaw, "5000000");
  assert.equal(calls.authorizationState, 1);
  assert.equal(calls.capture, 0, "offline authorization must not submit a Base transaction");

  const captured = await gate.capture({ authorization });
  assert.equal(captured.transactionHash, TX);
  assert.equal(calls.capture, 1);
  assert.equal(calls.wait, 1);
  assert.equal(calls.captureArgs[0], authorization.authorization.from);
  assert.equal(String(calls.captureArgs[1]).toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(calls.captureArgs[2], 5_000_000n);
});

test("authorization expiring inside timeout plus capture margin is refused before work", async () => {
  const { calls, gate } = harness();
  const { paymentProof } = await signedPayment(gate, {
    validBefore: NOW_SECONDS + 719n
  });
  await assert.rejects(
    () => authorize(gate, paymentProof),
    (error) => error.statusCode === 402
      && error.code === "payment_authorization_expiry_margin_insufficient"
      && error.details.requiredValidBefore === String(NOW_SECONDS + 720n)
  );
  assert.equal(calls.capture, 0);
});

test("underpayment and overpayment are both refused instead of rounded or accepted as tips", async () => {
  for (const value of ["4999999", "5000001"]) {
    const { calls, gate } = harness();
    const { paymentProof } = await signedPayment(gate, { value });
    await assert.rejects(
      () => authorize(gate, paymentProof),
      (error) => error.statusCode === 402 && error.code === "payment_exact_price_required"
    );
    assert.equal(calls.capture, 0);
  }
});

test("a signature built from symbol() rather than live name() is rejected, with a self-proving mutation guard", async () => {
  const { calls, gate } = harness();
  const { paymentProof } = await signedPayment(gate, { signingName: "USDC" });
  await assert.rejects(
    () => authorize(gate, paymentProof),
    (error) => error.statusCode === 402 && error.code === "payment_payer_mismatch"
  );
  assert.equal(calls.capture, 0);

  const source = readFileSync(new URL("./x402-verification-payment-gate.js", import.meta.url), "utf8");
  assertDomainReadsName(source);
  assert.throws(
    () => assertDomainReadsName(source.replace("this.token.name()", "this.token.symbol()")),
    /token name\(\)/u
  );
});

test("an already-used on-chain authorization nonce is refused", async () => {
  const { calls, gate } = harness({ nonceUsed: true });
  const { paymentProof } = await signedPayment(gate);
  await assert.rejects(
    () => authorize(gate, paymentProof),
    (error) => error.statusCode === 402 && error.code === "payment_authorization_used"
  );
  assert.equal(calls.capture, 0);
});

test("malformed authorization integers are actionable 402 refusals and transient domain reads retry", async () => {
  const transient = harness({ domainFailures: 1 });
  await assert.rejects(
    () => transient.gate.eip712Domain(),
    (error) => error.statusCode === 402 && error.code === "payment_domain_unavailable"
  );
  assert.equal((await transient.gate.eip712Domain()).name, "USD Coin");

  const { gate } = harness();
  const signed = await signedPayment(gate);
  const malformed = JSON.parse(Buffer.from(signed.paymentProof, "base64").toString("utf8"));
  malformed.payload.authorization.value = "5.0";
  const paymentProof = Buffer.from(JSON.stringify(malformed)).toString("base64");
  await assert.rejects(
    () => authorize(gate, paymentProof),
    (error) => error.statusCode === 402 && error.code === "payment_authorization_invalid"
  );
});

test("Verify payment config fails closed to the unavailable gate when Base settings are absent", () => {
  assert.deepEqual(resolveX402VerificationPaymentConfig({}), { enabled: false, mode: "disabled" });
  const warnings = [];
  const gate = createConfiguredX402VerificationPaymentGate(
    { X402_VERIFY_MODE: "enabled" },
    { logger: { warn: (...args) => warnings.push(args) } }
  );
  assert.equal(gate, undefined);
  assert.equal(warnings.length, 1);
});

test("configured factory wires the Base gate without importing the Hub gateway or settlement adapter", () => {
  const { gate: fixture } = harness();
  const configured = createConfiguredX402VerificationPaymentGate({
    X402_VERIFY_MODE: "enabled",
    X402_PAYMENT_NETWORK: "eip155:8453",
    BASE_RPC_URL: "https://base.example.test",
    X402_PAYMENT_ASSET_ADDRESS: ASSET,
    X402_PAYMENT_PAY_TO: PAY_TO,
    X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin",
    X402_PAYMENT_ASSET_EIP712_VERSION: "2",
    X402_PUBLIC_ORIGIN: "https://api.example.test",
    X402_VERIFY_CAPTURE_MARGIN_SECONDS: "600"
  }, {
    provider: fixture.provider,
    tokenContract: fixture.token,
    captureTokenContract: fixture.captureToken,
    logger: { warn() { assert.fail("valid Verify config degraded unexpectedly"); } }
  });
  assert.ok(configured instanceof X402VerificationPaymentGate);
  assert.equal(configured.config.captureMarginSeconds, 600);
});

function assertDomainReadsName(source) {
  assert.match(source, /this\.token\.name\(\)/u, "payment domain must read the token name()");
  assert.doesNotMatch(source, /this\.token\.symbol\(\)/u, "payment domain must never read symbol()");
}
