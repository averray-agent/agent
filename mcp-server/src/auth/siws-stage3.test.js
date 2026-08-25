import assert from "node:assert/strict";
import test from "node:test";

import { Wallet } from "ethers";

import {
  SUBSTRATE_NATIVE_READ_CAPABILITIES,
  resolveCapabilities
} from "./capabilities.js";
import { signToken } from "./jwt.js";
import { createAuthMiddleware } from "./middleware.js";
import { AuthorizationError } from "../core/errors.js";
import {
  accountId32FromSs58,
  parseWalletIdentity
} from "../core/wallet-identity.js";
import { buildDiscoveryManifest, buildPlatformCapabilities } from "../core/discovery-manifest.js";
import { createJobRoutes } from "../protocols/http/job-routes.js";
import {
  SUBSTRATE_MAPPING_CACHE_CEILING_MS,
  SUBSTRATE_MAPPING_CACHE_DEFAULT_MS,
  SubstrateMappingGate,
  loadSubstrateMappingGateConfig
} from "../services/substrate-mapping-gate.js";

const LONG_SECRET = "s".repeat(40);
const NATIVE_SS58 = "12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4";
const EVM_DERIVED_SS58 = "14RLk2G7hu2xMEYL1hbkcwbwWgjL6Nem3fL1maD2GYP1pGNe";
const ENDPOINT = "wss://asset-hub.example.test";

test("SIWS Stage 3: unmapped native capability resolution and the claim route refuse earning", async () => {
  const identity = parseWalletIdentity(NATIVE_SS58);
  const claims = nativeClaims(identity);
  assert.deepEqual(resolveCapabilities(claims), [...SUBSTRATE_NATIVE_READ_CAPABILITIES]);
  assert.equal(resolveCapabilities(claims).includes("jobs:claim"), false);

  const auth = authFor(identity, gateFor(async () => none()));
  await assert.rejects(
    () => auth(requestFor(identity), new URL("http://localhost/jobs/claim")),
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "substrate_mapping_required");
      assert.equal(
        error.message,
        "This Substrate-native account is not mapped for earning. Call pallet_revive.map_account first; it requires a refundable deposit paid by the account owner, not Averray, and the deposit is returned on unmap."
      );
      assert.deepEqual(error.details.mapping, {
        status: "unmapped",
        check: "revive.originalAccount",
        reason: "mapping_absent",
        remedy: "pallet_revive.map_account",
        deposit: {
          required: true,
          paidBy: "account_owner",
          paidByAverray: false,
          refundableOn: "unmap"
        }
      });
      assert.deepEqual(error.details.requiredCapabilities, ["jobs:claim"]);
      assert.deepEqual(error.details.missingCapabilities, ["jobs:claim"]);
      assert.equal(error.details.payout.address, identity.h160);
      assert.equal(error.details.payout.enabled, false);
      return true;
    }
  );
});

test("SIWS Stage 3: chain failure timeout and malformed mapping all refuse closed with a named reason", async () => {
  const identity = parseWalletIdentity(NATIVE_SS58);
  const cases = [
    ["chain down", { getSubstrateApi: async () => { throw new Error("offline"); } }, "malformed_or_unavailable"],
    ["timeout", readerFor(async () => new Promise(() => {})), "timeout"],
    ["malformed", readerFor(async () => ({})), "malformed_or_unavailable"]
  ];
  for (const [label, balanceReader, failure] of cases) {
    const gate = new SubstrateMappingGate({
      assetHubSubstrateEndpoint: ENDPOINT,
      balanceReader,
      queryTimeoutMs: 5,
      logger: silentLogger()
    });
    await assert.rejects(
      () => authFor(identity, gate)(requestFor(identity), new URL("http://localhost/jobs/claim")),
      (error) => {
        assert.equal(error.code, "substrate_mapping_unreadable", label);
        assert.equal(error.details.mapping.status, "unreadable", label);
        assert.equal(error.details.mapping.reason, "mapping_unreadable", label);
        assert.equal(error.details.mapping.failure, failure, label);
        assert.equal(error.details.earningEnabled, false, label);
        return true;
      }
    );
  }
});

test("SIWS Stage 3: EVM-derived identities bypass mapping and EVM claim auth stays byte-identical", async () => {
  let mappingCalls = 0;
  const evm = new Wallet(`0x${"44".repeat(32)}`);
  const { token } = signToken({ sub: evm.address, roles: [] }, {
    secret: LONG_SECRET,
    expiresInSeconds: 300
  });
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const gateThatMustNotRun = { check: async () => { mappingCalls += 1; throw new Error("must not run"); } };
  const baseline = await createAuthMiddleware({
    authConfig: authConfig(),
    logger: silentLogger()
  })(request, new URL("http://localhost/jobs/claim"));
  const stage3 = await createAuthMiddleware({
    authConfig: authConfig(),
    substrateMappingGate: gateThatMustNotRun,
    logger: silentLogger()
  })(request, new URL("http://localhost/jobs/claim"));
  assert.deepEqual(stage3, baseline);
  assert.equal(mappingCalls, 0);

  let chainReads = 0;
  const evmDerivedIdentity = parseWalletIdentity(EVM_DERIVED_SS58);
  const evmDerived = await authFor(
    evmDerivedIdentity,
    gateFor(async () => { chainReads += 1; return none(); })
  )(requestFor(evmDerivedIdentity), new URL("http://localhost/jobs/claim"));
  assert.equal(chainReads, 0);
  assert.equal(evmDerived.substrateMapping.mappingRequired, false);
  assert.equal(evmDerived.capabilities.includes("jobs:claim"), true);
});

test("SIWS Stage 3: a mapped native claim uses the derived H160 as worker and payout target", async () => {
  const identity = parseWalletIdentity(NATIVE_SS58);
  const accountId = accountId32FromSs58(identity.ss58);
  const authMiddleware = authFor(identity, gateFor(async () => some(accountId)));
  let claimCall;
  let responseBody;
  const route = createJobRoutes({
    authMiddleware,
    enforceLimit: async () => {},
    eventBus: undefined,
    externalPostingService: undefined,
    posterOnboardingService: undefined,
    protocol: "http",
    rateLimitConfig: {},
    readJsonBody: async () => ({ jobId: "job-native-mapped" }),
    respond(_response, _status, body) { responseBody = body; },
    service: {
      async claimJob(...args) {
        claimCall = args;
        return { sessionId: "session-native-mapped", wallet: args[0] };
      }
    }
  });

  const handled = await route({
    request: requestFor(identity),
    response: {},
    url: new URL("http://localhost/jobs/claim"),
    pathname: "/jobs/claim"
  });
  assert.equal(handled, true);
  assert.equal(claimCall[0].toLowerCase(), identity.h160);
  assert.equal(responseBody.wallet.toLowerCase(), identity.h160);
  assert.equal(claimCall[1], "job-native-mapped");
  assert.equal(claimCall[4], undefined);

  const auth = await authMiddleware(requestFor(identity), new URL("http://localhost/jobs/claim"));
  assert.equal(auth.capabilities.includes("jobs:claim"), true);
  assert.equal(auth.capabilities.includes("jobs:submit"), true);
  assert.deepEqual(auth.capabilities, resolveCapabilities(nativeClaims(identity), {
    substrateNativeMapped: true
  }));
  const sessionAuth = await authMiddleware(
    requestFor(identity, "GET"),
    new URL("http://localhost/auth/session")
  );
  assert.equal(sessionAuth.substrateMapping.mapped, true);
  assert.deepEqual(sessionAuth.capabilities, auth.capabilities);
});

test("SIWS Stage 3: a mismatched revive originalAccount is unmapped", async () => {
  const identity = parseWalletIdentity(NATIVE_SS58);
  const different = new Uint8Array(32).fill(99);
  const result = await gateFor(async () => some(different)).check(identity);
  assert.deepEqual(
    pick(result, ["mapped", "mappingRequired", "status", "reason", "source"]),
    {
      mapped: false,
      mappingRequired: true,
      status: "unmapped",
      reason: "original_account_mismatch",
      source: "chain"
    }
  );
});

test("SIWS Stage 3: positive mapping cache is ceiling-bounded and negatives never become positive cache entries", async () => {
  const identity = parseWalletIdentity(NATIVE_SS58);
  const accountId = accountId32FromSs58(identity.ss58);
  let nowMs = 0;
  let positiveReads = 0;
  const positiveGate = gateFor(async () => {
    positiveReads += 1;
    return some(accountId);
  }, {
    now: () => new Date(nowMs),
    positiveCacheTtlMs: SUBSTRATE_MAPPING_CACHE_CEILING_MS * 2
  });
  assert.equal((await positiveGate.check(identity)).source, "chain");
  nowMs = SUBSTRATE_MAPPING_CACHE_CEILING_MS - 1;
  assert.equal((await positiveGate.check(identity)).source, "positive_cache");
  assert.equal(positiveReads, 1);
  nowMs = SUBSTRATE_MAPPING_CACHE_CEILING_MS + 1;
  assert.equal((await positiveGate.check(identity)).source, "chain");
  assert.equal(positiveReads, 2);

  let negativeReads = 0;
  const negativeGate = gateFor(async () => {
    negativeReads += 1;
    return negativeReads === 1 ? none() : some(accountId);
  });
  assert.equal((await negativeGate.check(identity)).mapped, false);
  assert.equal((await negativeGate.check(identity)).mapped, true);
  assert.equal(negativeReads, 2);

  assert.equal(loadSubstrateMappingGateConfig({
    BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL: ENDPOINT,
    SUBSTRATE_MAPPING_CACHE_TTL_MS: "1234"
  }).positiveCacheTtlMs, 1234);
  assert.equal(loadSubstrateMappingGateConfig({
    BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL: ENDPOINT,
    SUBSTRATE_MAPPING_CACHE_TTL_MS: String(SUBSTRATE_MAPPING_CACHE_CEILING_MS * 2)
  }, { logger: silentLogger() }).positiveCacheTtlMs, SUBSTRATE_MAPPING_CACHE_DEFAULT_MS);
});

test("SIWS Stage 3: manifest modes capabilities and supported action surfaces stay consistent", () => {
  const manifest = buildDiscoveryManifest();
  const modes = manifest.onboarding.walletModes;
  assert.equal(modes.some((mode) => mode.id === "substrate-mapped"), false);
  const native = modes.find((mode) => mode.id === "substrate-native");
  assert.equal(native.status, "supported");
  assert.match(native.mappingRequirement, /pallet_revive\.map_account/u);
  assert.match(native.setup.mappingGuidance, /not Averray/u);
  assert.match(native.setup.mappingGuidance, /refunded on unmap/u);
  assert.deepEqual(manifest.auth.supportedWalletModes, ["evm-siwe", "substrate-native"]);
  assert.deepEqual(manifest.auth.plannedWalletModes, []);

  for (const path of ["/auth/nonce", "/auth/verify", "/jobs/claim", "/jobs/submit", "/jobs/preflight"] ) {
    const requirement = manifest.onboarding.actionRequirements.find((entry) => entry.path === path);
    assert.ok(requirement.walletModes.includes("substrate-native"), path);
  }
  const capabilities = buildPlatformCapabilities();
  assert.deepEqual(capabilities.auth, {
    scheme: manifest.auth.scheme,
    schemeId: manifest.auth.schemeId,
    entrypoints: manifest.auth.entrypoints,
    supportedWalletModes: manifest.auth.supportedWalletModes,
    plannedWalletModes: manifest.auth.plannedWalletModes
  });
});

function nativeClaims(identity) {
  return {
    sub: identity.ss58,
    roles: [],
    walletIdentity: identity
  };
}

function authFor(identity, substrateMappingGate) {
  return createAuthMiddleware({
    authConfig: authConfig(),
    substrateMappingGate,
    logger: silentLogger()
  });
}

function requestFor(identity, method = "POST") {
  const { token } = signToken(nativeClaims(identity), {
    secret: LONG_SECRET,
    expiresInSeconds: 300
  });
  return { method, headers: { authorization: `Bearer ${token}` } };
}

function authConfig() {
  return {
    jwtBackend: "hmac",
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
}

function gateFor(readOriginalAccount, overrides = {}) {
  return new SubstrateMappingGate({
    assetHubSubstrateEndpoint: ENDPOINT,
    balanceReader: readerFor(readOriginalAccount),
    logger: silentLogger(),
    ...overrides
  });
}

function readerFor(readOriginalAccount) {
  return {
    async getSubstrateApi() {
      return { query: { revive: { originalAccount: readOriginalAccount } } };
    },
    resetSubstrateApi() {}
  };
}

function some(accountId) {
  return {
    isNone: false,
    isSome: true,
    unwrap() {
      return { toU8a: () => new Uint8Array(accountId) };
    }
  };
}

function none() {
  return { isNone: true, isSome: false };
}

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
