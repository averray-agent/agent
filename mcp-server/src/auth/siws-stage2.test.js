import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const requireModule = createRequire(import.meta.url);
const {
  ed25519PairFromSeed,
  ed25519Sign,
  encodeAddress,
  sr25519PairFromSeed,
  sr25519Sign,
} = requireModule("@polkadot/util-crypto");
import { Wallet, hexlify } from "ethers";

import {
  SUBSTRATE_NATIVE_READ_CAPABILITIES,
} from "./capabilities.js";
import { signToken } from "./jwt.js";
import { createAuthMiddleware } from "./middleware.js";
import { buildSiweMessage, verifySiweMessage } from "./siwe.js";
import { AuthenticationError, AuthorizationError } from "../core/errors.js";
import { parseWalletIdentity } from "../core/wallet-identity.js";

const LONG_SECRET = "s".repeat(40);
const DOMAIN = "app.example.test";
const CHAIN_ID = 420420419;
const ISSUED_AT = "2026-08-25T09:00:00.000Z";
const EXPIRATION_TIME = "2099-08-25T09:05:00.000Z";

function nativeSigner(kind, fill) {
  const seed = new Uint8Array(32).fill(fill);
  const pair = kind === "sr25519"
    ? sr25519PairFromSeed(seed)
    : ed25519PairFromSeed(seed);
  const address = encodeAddress(pair.publicKey, 0);
  return {
    address,
    sign(message) {
      const bytes = new TextEncoder().encode(message);
      return hexlify(kind === "sr25519" ? sr25519Sign(bytes, pair) : ed25519Sign(bytes, pair));
    },
  };
}

function messageFor(address, overrides = {}) {
  return buildSiweMessage({
    domain: DOMAIN,
    address,
    statement: "Sign in to the Agent Platform.",
    uri: `https://${DOMAIN}`,
    chainId: CHAIN_ID,
    nonce: "stage2-nonce",
    issuedAt: ISSUED_AT,
    expirationTime: EXPIRATION_TIME,
    ...overrides,
  });
}

function strictAuthConfig() {
  return {
    jwtBackend: "hmac",
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
  };
}

test("SIWS Stage 2: EVM sign-in remains byte-identical at the shared verifier seam", async () => {
  const wallet = new Wallet(`0x${"11".repeat(32)}`);
  const message = messageFor(wallet.address);
  assert.equal(
    message,
    "app.example.test wants you to sign in with your Ethereum account:\n"
      + "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n\n"
      + "Sign in to the Agent Platform.\n\n"
      + "URI: https://app.example.test\n"
      + "Version: 1\n"
      + "Chain ID: 420420419\n"
      + "Nonce: stage2-nonce\n"
      + "Issued At: 2026-08-25T09:00:00.000Z\n"
      + "Expiration Time: 2099-08-25T09:05:00.000Z"
  );

  const signature = await wallet.signMessage(message);
  const verified = verifySiweMessage(message, signature, {
    expectedDomain: DOMAIN,
    expectedChainId: CHAIN_ID,
  });
  assert.deepEqual(verified, {
    domain: DOMAIN,
    address: wallet.address,
    statement: "Sign in to the Agent Platform.",
    uri: `https://${DOMAIN}`,
    version: "1",
    chainId: CHAIN_ID,
    nonce: "stage2-nonce",
    issuedAt: ISSUED_AT,
    expirationTime: EXPIRATION_TIME,
    notBefore: undefined,
    requestId: undefined,
    recoveredAddress: wallet.address,
  });

  const badChecksumAddress = wallet.address.replace("0x19E7", "0x19e7");
  const badChecksumMessage = messageFor(badChecksumAddress);
  assert.throws(
    () => verifySiweMessage(badChecksumMessage, signature, {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
    }),
    (error) => error?.code === "INVALID_ARGUMENT" && /bad address checksum/iu.test(error.message)
  );
});

test("SIWS Stage 2: sr25519 and ed25519 verify the unchanged EIP-4361-shaped message", () => {
  for (const [kind, fill] of [["sr25519", 7], ["ed25519", 9]]) {
    const signer = nativeSigner(kind, fill);
    const message = messageFor(signer.address);
    assert.match(message, /wants you to sign in with your Ethereum account:/u);
    const verified = verifySiweMessage(message, signer.sign(message), {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
    });
    assert.equal(verified.recoveredAddress, signer.address);
    assert.deepEqual(verified.walletIdentity, parseWalletIdentity(signer.address));
  }
});

test("SIWS Stage 2: identity form selects the scheme and both cross-scheme signatures are refused", async () => {
  const native = nativeSigner("sr25519", 11);
  const evm = new Wallet(`0x${"22".repeat(32)}`);
  const nativeMessage = messageFor(native.address);
  const evmMessage = messageFor(evm.address);
  const crossEvmSignature = await evm.signMessage(nativeMessage);

  assert.throws(
    () => verifySiweMessage(nativeMessage, crossEvmSignature, {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
    }),
    (error) => error instanceof AuthenticationError && error.code === "siwe_signature_mismatch"
  );
  assert.throws(
    () => verifySiweMessage(evmMessage, native.sign(evmMessage), {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
    }),
    (error) => error instanceof AuthenticationError
      && ["siwe_signature_mismatch", "siwe_recover_failed"].includes(error.code)
  );

  const evmSignature = await evm.signMessage(evmMessage);
  assert.equal(
    verifySiweMessage(evmMessage, evmSignature, {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
      scheme: "sr25519",
    }).recoveredAddress,
    evm.address
  );
  assert.equal(
    verifySiweMessage(nativeMessage, native.sign(nativeMessage), {
      expectedDomain: DOMAIN,
      expectedChainId: CHAIN_ID,
      scheme: "eip191",
    }).recoveredAddress,
    native.address
  );
});

test("SIWS Stage 2: native signatures keep the shared domain chain and expiry error codes", async () => {
  const native = nativeSigner("ed25519", 13);
  const evm = new Wallet(`0x${"33".repeat(32)}`);
  const validMessage = messageFor(native.address);
  const signature = native.sign(validMessage);
  const cases = [
    [{ expectedDomain: "wrong.example", expectedChainId: CHAIN_ID }, "siwe_domain_mismatch"],
    [{ expectedDomain: DOMAIN, expectedChainId: CHAIN_ID + 1 }, "siwe_chain_mismatch"],
  ];
  for (const [options, expectedCode] of cases) {
    for (const [message, signed] of [
      [validMessage, signature],
      [messageFor(evm.address), await evm.signMessage(messageFor(evm.address))],
    ]) {
      assert.throws(
        () => verifySiweMessage(message, signed, options),
        (error) => error instanceof AuthenticationError && error.code === expectedCode
      );
    }
  }

  const expiredMessage = messageFor(native.address, {
    expirationTime: "2026-08-25T08:59:59.000Z",
  });
  const expiredEvmMessage = messageFor(evm.address, {
    expirationTime: "2026-08-25T08:59:59.000Z",
  });
  for (const [message, signed] of [
    [expiredMessage, native.sign(expiredMessage)],
    [expiredEvmMessage, await evm.signMessage(expiredEvmMessage)],
  ]) {
    assert.throws(
      () => verifySiweMessage(message, signed, {
        expectedDomain: DOMAIN,
        expectedChainId: CHAIN_ID,
      }),
      (error) => error instanceof AuthenticationError && error.code === "siwe_expired"
    );
  }
});

test("SIWS Stage 2: native capabilities are closed read-only and earning refuses actionably", async () => {
  const native = nativeSigner("sr25519", 17);
  const walletIdentity = parseWalletIdentity(native.address);
  const { token } = signToken({
    sub: native.address,
    roles: ["admin"],
    capabilities: ["jobs:claim", "jobs:submit", "account:fund", "account:lock"],
    scopes: ["jobs:create"],
    walletIdentity,
  }, { secret: LONG_SECRET, expiresInSeconds: 300 });
  const requireAuth = createAuthMiddleware({
    authConfig: strictAuthConfig(),
    logger: { warn() {}, error() {}, info() {}, log() {} },
  });
  const headers = { authorization: `Bearer ${token}` };

  const read = await requireAuth(
    { method: "GET", headers: { ...headers } },
    new URL("http://localhost/me")
  );
  assert.equal(read.wallet.toLowerCase(), walletIdentity.h160);
  assert.equal(read.claims.sub, native.address);
  assert.deepEqual(read.capabilities, [...SUBSTRATE_NATIVE_READ_CAPABILITIES]);

  const earningActions = [
    ["/jobs/claim", ["jobs:claim"]],
    ["/jobs/submit", ["jobs:submit"]],
    ["/account/fund", ["account:fund"]],
    ["/locked-deposits/quote", ["account:lock"]],
  ];
  for (const [path, requiredCapabilities] of earningActions) {
    await assert.rejects(
      () => requireAuth(
        { method: "POST", headers: { ...headers } },
        new URL(`http://localhost${path}`)
      ),
      (error) => {
        assert.ok(error instanceof AuthorizationError);
        assert.equal(error.code, "substrate_native_read_only");
        assert.equal(
          error.message,
          "This is a Substrate-native read-only session. Mapping and earning arrive in a later stage; meanwhile it can browse jobs and read its own account and session history."
        );
        assert.deepEqual(error.details.requiredCapabilities, requiredCapabilities);
        assert.deepEqual(error.details.missingCapabilities, requiredCapabilities);
        assert.equal(error.details.sessionType, "substrate-native");
        assert.equal(error.details.access, "read_only");
        assert.equal(error.details.earningEnabled, false);
        assert.equal(error.details.mappingGate, "stage_3");
        assert.deepEqual(error.details.allowedMeanwhile, [
          "GET /me",
          "GET /jobs",
          "GET /account",
          "GET /sessions",
        ]);
        return true;
      }
    );
  }
});
