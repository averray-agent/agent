import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import { createIdleBalanceConsentRoutes } from "../protocols/http/idle-balance-consent-routes.js";
import {
  IDLE_BALANCE_ACTIVE_FUNDS_MOVEMENT,
  IDLE_BALANCE_ACTIVE_VENUE_DISCLOSURE,
  IDLE_BALANCE_AMOUNT_BASIS,
  IDLE_BALANCE_BOUND_INACTIVE_VENUE_DISCLOSURE,
  IDLE_BALANCE_BUFFER_FUNDS_MOVEMENT,
  IDLE_BALANCE_RETURN_TERMS,
  IDLE_BALANCE_UNBOUND_VENUE_DISCLOSURE,
  IdleBalanceConsentService,
  hashIdleBalanceConsentTerms,
  loadIdleBalanceConsentConfig
} from "./idle-balance-consent-service.js";

const SIGNER = new Wallet(`0x${"11".repeat(32)}`);
const OTHER = new Wallet(`0x${"22".repeat(32)}`);
const START = new Date("2026-08-25T10:00:00.000Z");
const ASSET = "0x0000053900000000000000000000000001200000";
const POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const POOL_V21 = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";

function harness({ routeLive = true, venueState: initialVenueState } = {}) {
  const stateStore = new MemoryStateStore();
  let clock = new Date(START);
  let venueState = initialVenueState ?? {
    venueAdapter: "0x0000000000000000000000000000000000000000",
    activeVenueDeploymentId: 0n
  };
  const service = new IdleBalanceConsentService({
    stateStore,
    config: {
      routeLive,
      chainId: 420_420_419,
      assetAddress: ASSET,
      depositPoolAddress: POOL
    },
    venueStateReader: {
      async readVenueState() {
        return venueState;
      }
    },
    chainId: 420_420_419,
    siweDomain: "api.averray.com",
    publicBaseUrl: "https://api.averray.com",
    now: () => new Date(clock)
  });
  return {
    service,
    stateStore,
    setVenueState(value) { venueState = value; },
    setNow(value) { clock = new Date(value); }
  };
}

async function signedPayload(h, nonce = "consent001") {
  const quote = await h.service.quote(SIGNER.address, { consentNonce: nonce });
  return {
    quote,
    payload: {
      terms: quote.terms,
      termsHash: quote.termsHash,
      consentSignature: await SIGNER.signMessage(quote.consent.message)
    }
  };
}

function routes(h) {
  return createIdleBalanceConsentRoutes({
    authMiddleware: async () => ({ wallet: SIGNER.address }),
    idleBalanceConsentService: h.service,
    readJsonBody: async (request) => request.body ?? {},
    respond: (response, statusCode, body) => Object.assign(response, { statusCode, body })
  });
}

async function invoke(route, path, body = {}, method = "POST") {
  const response = {};
  const url = new URL(path, "https://api.averray.com");
  const handled = await route({
    request: { method, body },
    response,
    url,
    pathname: url.pathname
  });
  return { handled, response };
}

test("no consent, expired consent, and revoked consent refuse allocation by named reason", async () => {
  const missing = harness();
  assert.deepEqual(await missing.service.assessAllocationAttempt(SIGNER.address), {
    allowed: false,
    reason: "idle_balance_consent_missing"
  });

  const expired = harness();
  const expiredPayload = await signedPayload(expired, "expired001");
  await expired.service.captureConsent(SIGNER.address, expiredPayload.payload);
  expired.setNow("2026-11-23T10:00:00.001Z");
  assert.equal(
    (await expired.service.assessAllocationAttempt(SIGNER.address)).reason,
    "idle_balance_consent_expired"
  );

  const revoked = harness();
  const revokedPayload = await signedPayload(revoked, "revoked001");
  await revoked.service.captureConsent(SIGNER.address, revokedPayload.payload);
  await revoked.service.revokeConsent(SIGNER.address);
  assert.equal(
    (await revoked.service.assessAllocationAttempt(SIGNER.address)).reason,
    "idle_balance_consent_revoked"
  );
});

test("revocation is effective immediately on the next uncached allocation consent read", async () => {
  const h = harness();
  const originalRead = h.stateStore.getIdleBalanceConsent.bind(h.stateStore);
  let durableReads = 0;
  h.stateStore.getIdleBalanceConsent = async (...args) => {
    durableReads += 1;
    return originalRead(...args);
  };
  const { payload } = await signedPayload(h, "revoke002");
  await h.service.captureConsent(SIGNER.address, payload);
  assert.equal((await h.service.assessAllocationAttempt(SIGNER.address)).allowed, true);
  const readsBeforeRevocation = durableReads;
  await h.service.revokeConsent(SIGNER.address);
  assert.equal(
    (await h.service.assessAllocationAttempt(SIGNER.address)).reason,
    "idle_balance_consent_revoked"
  );
  assert.equal(durableReads, readsBeforeRevocation + 1);
});

test("the consent signature rejects every material-term mutation", async () => {
  const h = harness();
  const { quote, payload } = await signedPayload(h, "mutation001");
  const mutations = [
    ["wallet", (terms) => { terms.wallet = OTHER.address; }],
    ["amount basis", (terms) => { terms.amountBasis = `${terms.amountBasis} Altered.`; }],
    ["asset", (terms) => { terms.asset.address = OTHER.address; }],
    ["venue disclosure", (terms) => { terms.venueDisclosure = `${terms.venueDisclosure} Altered.`; }],
    ["nonce", (terms) => { terms.consentNonce = "mutation002"; }]
  ];
  for (const [name, mutate] of mutations) {
    const terms = structuredClone(quote.terms);
    mutate(terms);
    await assert.rejects(
      () => h.service.captureConsent(SIGNER.address, {
        terms,
        termsHash: hashIdleBalanceConsentTerms(terms),
        consentSignature: payload.consentSignature
      }),
      (error) => {
        assert.equal(error.code, "idle_balance_consent_signer_mismatch", name);
        return true;
      }
    );
  }
  assert.equal(await h.stateStore.getIdleBalanceConsent(SIGNER.address), undefined);
});

test("served consent terms change only when the live venue exposure state changes", async () => {
  const h = harness();
  const result = await invoke(routes(h), "/account/idle-allocation/quote", {
    consentNonce: "terms001"
  });
  assert.equal(result.response.statusCode, 200);
  const quote = result.response.body;
  assert.deepEqual(quote.terms, {
    schemaVersion: 1,
    wallet: SIGNER.address,
    product: "idle-balance allocation",
    amountBasis: IDLE_BALANCE_AMOUNT_BASIS,
    asset: {
      address: ASSET,
      symbol: "USDC",
      decimals: 6,
      chainId: 420_420_419
    },
    venue: {
      route: "deposit_pool_v2",
      depositPool: POOL,
      downstream: "pool buffer"
    },
    venueDisclosure: IDLE_BALANCE_UNBOUND_VENUE_DISCLOSURE,
    fundsMovement: IDLE_BALANCE_BUFFER_FUNDS_MOVEMENT,
    returnTerms: IDLE_BALANCE_RETURN_TERMS,
    consentNonce: "terms001",
    issuedAt: "2026-08-25T10:00:00.000Z",
    quoteExpiresAt: "2026-08-25T10:10:00.000Z",
    consentExpiresAt: "2026-11-23T10:00:00.000Z"
  });
  assert.match(quote.terms.fundsMovement, /leave position\.liquid/u);
  assert.doesNotMatch(quote.terms.venueDisclosure, /deployed .* external venue/u);
  assert.match(quote.terms.venueDisclosure, /held in the DepositPoolV2 buffer/u);
  assert.match(quote.terms.venueDisclosure, /no venue exposure and no venue yield today/u);
  assert.match(quote.terms.fundsMovement, /Principal is at risk/u);
  assert.match(quote.terms.fundsMovement, /not instant/u);
  assert.doesNotMatch(quote.terms.fundsMovement, /none —/u);
  assert.match(quote.terms.returnTerms, /queues with a disclosed ETA/u);

  h.setVenueState({
    venueAdapter: "0x1111111111111111111111111111111111111111",
    activeVenueDeploymentId: 0n
  });
  const boundInactive = await h.service.quote(SIGNER.address, { consentNonce: "terms002" });
  assert.equal(boundInactive.terms.venue.downstream, "pool buffer");
  assert.equal(boundInactive.terms.venueDisclosure, IDLE_BALANCE_BOUND_INACTIVE_VENUE_DISCLOSURE);
  assert.equal(boundInactive.terms.fundsMovement, IDLE_BALANCE_BUFFER_FUNDS_MOVEMENT);

  h.setVenueState({
    venueAdapter: "0x1111111111111111111111111111111111111111",
    activeVenueDeploymentId: 7n
  });
  const active = await h.service.quote(SIGNER.address, { consentNonce: "terms003" });
  assert.equal(active.terms.venue.downstream, "configured external venue");
  assert.equal(active.terms.venueDisclosure, IDLE_BALANCE_ACTIVE_VENUE_DISCLOSURE);
  assert.equal(active.terms.fundsMovement, IDLE_BALANCE_ACTIVE_FUNDS_MOVEMENT);
  assert.notEqual(active.terms.venueDisclosure, quote.terms.venueDisclosure);
  assert.notEqual(active.terms.fundsMovement, quote.terms.fundsMovement);
  assert.notEqual(active.termsHash, boundInactive.termsHash);
  assert.equal(active.terms.returnTerms, quote.terms.returnTerms);

  const promisedYieldRate = /\b(?:apy|apr)\b|\d+(?:\.\d+)?\s*%|guaranteed yield|yield rate/iu;
  for (const terms of [quote.terms, boundInactive.terms, active.terms]) {
    assert.doesNotMatch(JSON.stringify(terms), promisedYieldRate);
  }
});

test("a consent quote fails closed when the live venue state is unreadable", async () => {
  const h = harness();
  h.service.venueStateReader = {
    async readVenueState() {
      throw new Error("rpc unavailable");
    }
  };
  await assert.rejects(
    () => h.service.quote(SIGNER.address, { consentNonce: "unreadable1" }),
    (error) => error.code === "idle_balance_venue_state_unavailable"
  );
});

test("route-not-live serves a named unavailable state and captures no consent", async () => {
  assert.equal(loadIdleBalanceConsentConfig({}, {
    chainId: 420_420_419,
    assetAddress: ASSET,
    depositPoolAddress: POOL
  }).routeLive, false);
  const h = harness({ routeLive: false });
  assert.deepEqual(h.service.getCapability(), {
    schemaVersion: 1,
    available: false,
    reason: "route_not_live",
    product: "idle-balance allocation",
    endpoints: {
      status: { method: "GET", path: "/account/idle-allocation" }
    }
  });
  const result = await invoke(routes(h), "/account/idle-allocation/quote");
  assert.equal(result.handled, true);
  assert.deepEqual(result.response.body, {
    schemaVersion: 1,
    available: false,
    reason: "route_not_live",
    product: "idle-balance allocation"
  });
  assert.equal("consent" in result.response.body, false);
  await assert.rejects(
    () => h.service.captureConsent(SIGNER.address, {}),
    (error) => error.code === "route_not_live"
  );
  assert.equal(await h.stateStore.getIdleBalanceConsent(SIGNER.address), undefined);
});

test("mainnet A6 serves idle-allocation consent as available while the default remains off", () => {
  const template = readFileSync(
    new URL("../../../deploy/backend.mainnet.env.template", import.meta.url),
    "utf8"
  );
  const match = template.match(/^IDLE_BALANCE_ALLOCATION_ROUTE_LIVE=(.+)$/mu);
  assert.ok(match, "mainnet template must declare the consent-route switch");
  const config = loadIdleBalanceConsentConfig({
    IDLE_BALANCE_ALLOCATION_ROUTE_LIVE: match[1]
  }, {
    chainId: 420_420_419,
    assetAddress: ASSET,
    depositPoolAddress: POOL_V21
  });
  const service = new IdleBalanceConsentService({
    stateStore: new MemoryStateStore(),
    config,
    chainId: 420_420_419,
    siweDomain: "api.averray.com",
    publicBaseUrl: "https://api.averray.com"
  });

  assert.equal(service.getCapability().available, true);
  assert.equal(service.getCapability().reason, undefined);
  assert.equal(config.depositPoolAddress, POOL_V21);
  assert.equal(loadIdleBalanceConsentConfig({}, {
    chainId: 420_420_419,
    assetAddress: ASSET,
    depositPoolAddress: POOL_V21
  }).routeLive, false);
});

test("consent capture changes no balance, position, or allocation", async () => {
  const h = harness();
  const account = {
    wallet: SIGNER.address.toLowerCase(),
    liquid: { USDC: 12.5 },
    reserved: { USDC: 1 },
    strategyAllocated: {},
    collateralLocked: { USDC: 0 },
    jobStakeLocked: { USDC: 0 },
    debtOutstanding: { USDC: 0 }
  };
  await h.stateStore.upsertAccountOverlay(SIGNER.address, account);
  const before = await h.stateStore.getAccountOverlay(SIGNER.address);
  const locksBefore = await h.stateStore.listLockedTierEntries(SIGNER.address);
  const { payload } = await signedPayload(h, "nomovement1");

  await h.service.captureConsent(SIGNER.address, payload);

  assert.deepEqual(await h.stateStore.getAccountOverlay(SIGNER.address), before);
  assert.deepEqual(await h.stateStore.listLockedTierEntries(SIGNER.address), locksBefore);
  assert.equal((await h.stateStore.getIdleBalanceConsent(SIGNER.address)).status, "active");
});
