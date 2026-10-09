import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { canonicalBadgeReceiptBytes, verifyBadgeReceiptSignature } from "../../core/badge-receipt-signing.js";
import { verifyReceiptSignature } from "../../../../app/lib/ui/receipt-signature-verification.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { BADGE_FILTER_VALUES, createBadgeRoutes, createListBadgeReceipts as createLister } from "./badge-routes.js";
import { hashWorkReceiptContent } from "../../core/work-receipt.js";

const SESSION = { sessionId: "session-1", jobId: "job-1" };
const JOB = { id: "job-1", title: "Demo job" };
const VERIFICATION = { outcome: "approved" };
const SIGNERS = [
  {
    role: "operator",
    wallet: "0x1111111111111111111111111111111111111111",
    at: "2026-04-16T14:00:00.000Z",
    status: "posted",
  },
  {
    role: "verifier",
    wallet: "0x2222222222222222222222222222222222222222",
    at: "2026-04-16T14:29:00.000Z",
    status: "signed",
  },
  {
    role: "worker",
    wallet: "0x3333333333333333333333333333333333333333",
    at: "2026-04-16T14:12:00.000Z",
    status: "submitted",
  },
];
const BADGE = { schemaVersion: "averray.agent-badge.v1", sessionId: "session-1", signers: SIGNERS };
const RECEIPTS = [{ sessionId: "session-1", badgeHash: "0xabc", signers: SIGNERS }];
const STORED_BADGE = {
  averray: {
    sessionId: "session-pruned",
    jobId: "job-pruned",
    worker: "0x3333333333333333333333333333333333333333",
    completedAt: "2026-04-16T14:29:00.000Z",
    evidenceHash: "0xabc",
    chainJobId: "0xdef"
  },
  signers: SIGNERS
};
const STORED_RUN_RECEIPT = {
  schemaVersion: "averray.run-receipt.v1",
  kind: "run",
  sessionId: "session-pruned",
  jobId: "job-pruned",
  worker: "0x3333333333333333333333333333333333333333",
  verdict: {
    outcome: "rejected",
    reasonCode: "BENCHMARK_THRESHOLD_MISSED",
    evidenceHash: "0xabc",
    policyTags: []
  },
  timestamps: { verifiedAt: "2026-04-16T14:29:00.000Z" },
  signers: SIGNERS,
  canonicalUrl: "https://api.averray.com/badges/session-pruned/run"
};

test("V3b one-item query filters canonical fields and sorts signed verifiedAt across session pages", async () => {
  const sessions = Array.from({ length: 120 }, (_, i) => ({ sessionId: `s-${i}`, updatedAt: "2099-01-01T00:00:00Z" }));
  const runs = new Map(sessions.map((session) => [session.sessionId, {
    ...STORED_RUN_RECEIPT, ...session,
    verifier: { handler: "deterministic" }, verdict: { outcome: "approved" },
    settlement: { settlementTx: "0x" + "a".repeat(64) },
    timestamps: { verifiedAt: "2026-10-09T15:00:00Z" }
  }]));
  const github = (id, date, changes = {}) => runs.set(id, { ...runs.get(id),
    verifier: { handler: "github_pr" }, timestamps: { verifiedAt: date }, ...changes });
  github("s-0", "2026-10-09T12:00:00Z"); // Legacy session order would select this.
  github("s-1", "2026-10-09T16:00:00Z", { verdict: { outcome: "rejected" } });
  github("s-2", "2026-10-09T16:00:00Z", { settlement: {} });
  github("s-3", undefined); // Plausible recent unsigned updatedAt must not count.
  github("s-119", "2026-10-09T14:00:00Z");
  let badgeReads = 0;
  const list = createLister({
    stateStore: {
      listRecentSessions: async (limit, offset) => sessions.slice(offset, offset + limit),
      getRunReceiptDocument: async (id) => runs.get(id),
      getBadgeDocument: async () => { badgeReads++; }
    }, service: {}, verifierService: {}
  });
  const h = makeHarness({ listBadgeReceipts: list });
  const query = "?handler=github_pr&outcome=approved&settled=true&sort=verifiedAt:desc&limit=1";
  async function get(suffix = "", headers = {}) {
    const response = {};
    await h.route({ request: { method: "GET", headers }, response, pathname: "/badges",
      url: new URL("http://localhost/badges" + query + suffix) });
    return response;
  }
  const first = await get();
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].document.sessionId, "s-119");
  assert.deepEqual(first.body.items[0].document, runs.get("s-119"), "signed document is not rewritten");
  assert.equal(first.body.items[0].schemaVersion, "averray.badge-list-item.v1");
  assert.ok(Buffer.byteLength(JSON.stringify(first.body)) < 50_000);
  assert.equal(badgeReads, 0, "filtered reads must not rebuild badge rows");
  assert.match(first.headers.link, /handler=github_pr/u);
  const next = await get("&cursor=" + encodeURIComponent(first.body.nextCursor));
  assert.equal(next.body.items[0].document.sessionId, "s-0");
  assert.equal(next.body.nextCursor, null);
  assert.equal((await get("", { "if-none-match": first.headers.etag })).statusCode, 304);
  github("s-119", "2026-10-09T14:01:00Z");
  assert.equal((await get("", { "if-none-match": first.headers.etag })).statusCode, 200);
  runs.clear();
  assert.deepEqual((await get()).body.items, []);
});

test("V3b unknown filter values and names are 400 with the supported set", async () => {
  const h = makeHarness();
  for (const [key, supported] of Object.entries(BADGE_FILTER_VALUES)) {
    await assert.rejects(h.route({ request: { method: "GET" }, response: {}, pathname: "/badges",
      url: new URL(`http://localhost/badges?${key}=typo`) }), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.details.parameter, key);
      assert.deepEqual(error.details.supported, supported);
      return true;
    });
    for (const value of supported) {
      await h.route({ request: { method: "GET" }, response: {}, pathname: "/badges",
        url: new URL(`http://localhost/badges?${key}=${encodeURIComponent(value)}`) });
      assert.equal(h.calls.findLast(([name]) => name === "listBadgeReceipts")[1][key], value);
    }
  }
  await assert.rejects(h.route({ request: { method: "GET" }, response: {}, pathname: "/badges",
    url: new URL("http://localhost/badges?typo=true") }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details.unknown, ["typo"]);
    assert.deepEqual(error.details.supported, ["limit", "cursor", ...Object.keys(BADGE_FILTER_VALUES)]);
    return true;
  });
  const schema = JSON.parse(readFileSync(new URL("../../../../docs/api/openapi.json", import.meta.url), "utf8"));
  for (const [key, values] of Object.entries(BADGE_FILTER_VALUES)) {
    assert.deepEqual(schema.paths["/badges"].get.parameters.find((p) => p.name === key).schema.enum, values);
  }
});

function addressedWorkReceipt({ sessionId, jobId, outcome = "approved", marker = "fixture" }) {
  const content = {
    schemaVersion: "averray.work-receipt.v1",
    sessionId,
    jobId,
    marker,
    verdict: { outcome, reasonCode: outcome === "approved" ? "MATCH" : "MISMATCH" },
    intent: {
      specSource: "chain_verified",
      poster: "0x1111111111111111111111111111111111111111",
      valueAtRisk: { asset: "USDC", amountRaw: "400000" }
    },
    settlement: { assetSymbol: "USDC", workerAmountRaw: "400000" },
    timestamps: { verifiedAt: "2026-08-24T10:00:00.000Z" }
  };
  return { ...content, receiptId: hashWorkReceiptContent(content) };
}

function createListBadgeReceipts(options) {
  return createLister({ ...options, stateStore: {
    listRecentSessions: (limit, offset) => options.service.listRecentSessions(limit, { progression: false, offset }),
    ...options.stateStore
  } });
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createBadgeRoutes({
    badgeReceiptSigner: overrides.badgeReceiptSigner,
    buildBadgeFromSession: (input) => {
      calls.push(["buildBadgeFromSession", input]);
      if (overrides.badgeError) {
        throw overrides.badgeError;
      }
      return overrides.badge ?? BADGE;
    },
    deriveBadgeLineage: (session, job) => {
      calls.push(["deriveBadgeLineage", { session, job }]);
      return overrides.lineage ?? { parent: { sessionId: "parent-1" } };
    },
    listBadgeReceipts: overrides.listBadgeReceipts ?? (async (limit) => {
      calls.push(["listBadgeReceipts", limit]);
      return overrides.receipts ?? { items: RECEIPTS, limit: limit.limit, nextCursor: null };
    }),
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    publicBaseUrl: "https://averray.com",
    posterAddress: "0xposter",
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: {
      resumeSession: async (sessionId) => {
        calls.push(["resumeSession", sessionId]);
        if (overrides.resumeError) {
          throw overrides.resumeError;
        }
        return overrides.session ?? SESSION;
      },
      getJobDefinition: (jobId) => {
        calls.push(["getJobDefinition", jobId]);
        if (overrides.jobError) {
          throw overrides.jobError;
        }
        return overrides.job ?? JOB;
      },
    },
    stateStore: overrides.stateStore,
    verifierAddress: "0xverifier",
    verifierService: {
      getResult: async (sessionId) => {
        calls.push(["getResult", sessionId]);
        return overrides.verification ?? VERIFICATION;
      },
    },
  });
  return { calls, response, route };
}

test("badge routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-badges"),
    pathname: "/not-badges",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /.well-known/badge-receipt-jwks.json publishes the receipt verification key", async () => {
  const jwks = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "badge-1", x: "x", y: "y" }] };
  const { calls, response, route } = makeHarness({
    badgeReceiptSigner: { getJwks: () => jwks }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/.well-known/badge-receipt-jwks.json"),
    pathname: "/.well-known/badge-receipt-jwks.json"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, jwks);
  assert.deepEqual(calls.at(-1), ["respond", {
    statusCode: 200,
    body: jwks,
    headers: { "cache-control": "public, max-age=300" }
  }]);
});

test("GET /badges parses limit and returns cached receipts", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges?limit=17"),
    pathname: "/badges",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { items: RECEIPTS, limit: 17, nextCursor: null });
  assert.deepEqual(response.body.items[0].signers.map((signer) => signer.role), ["operator", "verifier", "worker"]);
  assert.ok(response.body.items[0].signers.every((signer) => signer.at && !/^0x0{40}$/u.test(signer.wallet)));
  assert.deepEqual(calls, [
    ["parseLimit", { fallback: 50, max: 500 }],
    ["listBadgeReceipts", { limit: 17, cursor: null }],
    ["respond", {
      statusCode: 200,
      body: { items: RECEIPTS, limit: 17, nextCursor: null },
      headers: response.headers,
    }],
  ]);
});

test("GET /badges/:sessionId builds public badge metadata", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-1"),
    pathname: "/badges/session-1",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, BADGE);
  assert.equal("signature" in response.body, false, "unconfigured test mode must remain honestly unsigned");
  assert.deepEqual(response.body.signers, SIGNERS);
  assert.ok(response.body.signers.every((signer) => signer.at && !/^0x0{40}$/u.test(signer.wallet)));
  assert.deepEqual(calls, [
    ["resumeSession", "session-1"],
    ["getResult", "session-1"],
    ["getJobDefinition", "job-1"],
    ["deriveBadgeLineage", { session: SESSION, job: JOB }],
    ["buildBadgeFromSession", {
      session: SESSION,
      job: JOB,
      verification: VERIFICATION,
      context: {
        publicBaseUrl: "https://averray.com",
        posterAddress: "0xposter",
        verifierAddress: "0xverifier",
        lineage: { parent: { sessionId: "parent-1" } },
      },
    }],
    ["respond", {
      statusCode: 200,
      body: BADGE,
      headers: { "cache-control": "public, max-age=60" },
    }],
  ]);
});

test("GET /badges/:sessionId decodes the session id", async () => {
  const { calls, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/badges/session%2Fencoded"),
    pathname: "/badges/session%2Fencoded",
  });

  assert.equal(handled, true);
  assert.deepEqual(calls[0], ["resumeSession", "session/encoded"]);
});

test("GET /badges/ rejects an empty session id", async () => {
  const { response, route } = makeHarness();

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/badges/"),
      pathname: "/badges/",
    }),
    (error) => error instanceof ValidationError
      && error.message === "sessionId path segment is required."
  );
});

test("GET /badges/:sessionId returns not_found for missing sessions", async () => {
  const { calls, response, route } = makeHarness({
    resumeError: new NotFoundError("Session missing.", "session_not_found"),
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/missing-session"),
    pathname: "/badges/missing-session",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", sessionId: "missing-session" });
  assert.deepEqual(calls, [
    ["resumeSession", "missing-session"],
    ["respond", {
      statusCode: 404,
      body: { status: "not_found", sessionId: "missing-session" },
      headers: {},
    }],
  ]);
});

test("GET /badges/:sessionId returns not_ready when badge construction says so", async () => {
  const { response, route } = makeHarness({
    badgeError: new NotFoundError("Badge not ready.", "badge_not_ready"),
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-1"),
    pathname: "/badges/session-1",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    status: "not_ready",
    sessionId: "session-1",
    reason: "Badge not ready.",
  });
});

test("GET /badges/:sessionId serves the immutable document after its job is pruned", async () => {
  const { calls, response, route } = makeHarness({
    stateStore: {
      getBadgeDocument: async (sessionId) => {
        calls.push(["getBadgeDocument", sessionId]);
        return STORED_BADGE;
      }
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned"),
    pathname: "/badges/session-pruned"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, STORED_BADGE);
  assert.equal("signature" in response.body, false);
  assert.deepEqual(calls.map(([name]) => name), ["getBadgeDocument", "respond"]);
});

test("GET /badges/:sessionId returns the persisted receipt signature", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-11T00:00:00.000Z" };
  const signedBadge = { ...STORED_BADGE, signature };
  const { response, route } = makeHarness({
    stateStore: { getBadgeDocument: async () => signedBadge }
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned"),
    pathname: "/badges/session-pruned"
  });

  assert.deepEqual(response.body.signature, signature);
});

test("GET /badges/:sessionId/run serves the immutable run receipt after job pruning", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-12T00:00:00.000Z" };
  const signedRunReceipt = { ...STORED_RUN_RECEIPT, signature };
  const { calls, response, route } = makeHarness({
    jobError: new Error("Unknown job"),
    stateStore: { getRunReceiptDocument: async (sessionId) => {
      calls.push(["getRunReceiptDocument", sessionId]);
      return signedRunReceipt;
    } }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned/run"),
    pathname: "/badges/session-pruned/run"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, signedRunReceipt);
  assert.deepEqual(calls.map(([name]) => name), ["getRunReceiptDocument", "respond"]);
});

test("GET /badges/:sessionId/run returns not_found when no verdict receipt exists", async () => {
  const { response, route } = makeHarness({
    stateStore: { getRunReceiptDocument: async () => undefined }
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/never-claimed/run"),
    pathname: "/badges/never-claimed/run"
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", kind: "run", sessionId: "never-claimed" });
});

test("GET /receipts preserves stored receipt bytes and decorates only after content-address verification", async () => {
  const content = {
    schemaVersion: "averray.work-receipt.v1",
    verdict: { outcome: "approved", reasonCode: "DETERMINISTIC_MATCH" },
    intent: {
      specSource: "claim_snapshot",
      poster: "0x1111111111111111111111111111111111111111",
      valueAtRisk: { asset: "USDC", amountRaw: "400000" }
    },
    settlement: { assetSymbol: "USDC", workerAmountRaw: "400000" }
  };
  const receiptId = hashWorkReceiptContent(content);
  const workReceipt = { ...content, receiptId };
  const storedBytes = JSON.stringify(workReceipt);
  const { calls, response, route } = makeHarness({
    stateStore: { getWorkReceiptDocument: async (id) => {
      calls.push(["getWorkReceiptDocument", id]);
      return workReceipt;
    } }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/receipts/${receiptId}`),
    pathname: `/receipts/${receiptId}`
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(workReceipt), storedBytes, "serve-time decoration must not mutate storage");
  assert.equal(hashWorkReceiptContent(workReceipt), receiptId, "pre-existing stored receipt must reproduce its hash");
  assert.deepEqual(response.body, {
    schemaVersion: "averray.receipt-envelope.v1",
    document: workReceipt,
    unsignedPresentation: {
      result: "PASS",
      buyer: workReceipt.intent.poster,
      assetContext: {
        symbol: "USDC",
        chain: "eip155:420420419",
        chainName: "Polkadot Hub",
        assetId: 1337,
        token: "0x0000053900000000000000000000000001200000"
      }
    }
  });
  const servedCanonical = response.body.document;
  assert.deepEqual(servedCanonical, workReceipt, "served receipt differs from storage only by presentation fields");
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(calls.map(([name]) => name), ["getWorkReceiptDocument", "respond"]);
});

test("served badge and receipt envelope verify end to end against the published JWKS", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), alg: "ES256", kid: "badge-1", use: "sig" };
  const signedAt = "2026-10-07T12:00:00.000Z";
  function signed(document) {
    const header = { alg: "ES256", kid: "badge-1", signedAt, typ: "averray-badge-receipt+jws" };
    const protectedPart = Buffer.from(JSON.stringify(header)).toString("base64url");
    const input = `${protectedPart}.${canonicalBadgeReceiptBytes(document).toString("base64url")}`;
    const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { ...document, signature: { alg: "ES256", kid: "badge-1", signedAt, sig: `${protectedPart}..${signature}` } };
  }
  const receipt = signed(addressedWorkReceipt({ sessionId: "signed-session", jobId: "signed-job" }));
  const badge = signed(BADGE);
  const h = makeHarness({ stateStore: { getWorkReceiptDocument: async () => receipt, getBadgeDocument: async () => badge },
    badgeReceiptSigner: { getJwks: () => ({ keys: [jwk] }) } });
  async function get(path) {
    const response = {};
    await h.route({ request: { method: "GET" }, response, url: new URL(`http://localhost${path}`), pathname: path });
    assert.equal(response.statusCode, 200);
    return JSON.parse(JSON.stringify(response.body));
  }
  const jwks = await get("/.well-known/badge-receipt-jwks.json");
  const servedBadge = await get("/badges/signed-session");
  assert.equal(verifyBadgeReceiptSignature(servedBadge, jwks.keys[0]), true);
  const served = await get(`/receipts/${receipt.receiptId}`);
  assert.equal(served.schemaVersion, "averray.receipt-envelope.v1");
  assert.deepEqual(served.document, receipt);
  assert.equal(verifyBadgeReceiptSignature(served.document, jwks.keys[0]), true);
  const verify = (document) => verifyReceiptSignature({ document, cryptoImpl: webcrypto,
    fetchImpl: async () => ({ ok: true, json: async () => jwks }) });
  assert.equal((await verify(served)).state, "verified");
  served.unsignedPresentation.result = "FAIL";
  assert.equal((await verify(served)).state, "verified", "presentation is explicitly outside the signature");
  served.document.verdict.outcome = "rejected";
  assert.equal((await verify(served)).state, "failed", "signed verdict mutations must fail");
});

test("GET /receipts resolution order keeps exact receipt ids ahead of 0x-shaped job aliases", async () => {
  const stateStore = new MemoryStateStore();
  const exact = addressedWorkReceipt({ sessionId: "session-exact", jobId: "job-exact", marker: "exact" });
  const aliasTarget = addressedWorkReceipt({
    sessionId: "session-alias-target",
    jobId: exact.receiptId,
    marker: "job-alias-target"
  });
  await stateStore.putWorkReceiptDocument(exact.sessionId, exact);
  await stateStore.putWorkReceiptDocument(aliasTarget.sessionId, aliasTarget);
  const { response, route } = makeHarness({ stateStore });

  await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/receipts/${exact.receiptId}`),
    pathname: `/receipts/${exact.receiptId}`
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.document.receiptId, exact.receiptId);
  assert.equal(response.body.document.marker, "exact");
});

test("GET /receipts session alias redirects once and the canonical fetch returns the immutable receipt", async () => {
  const stateStore = new MemoryStateStore();
  const document = addressedWorkReceipt({
    sessionId: "Wiki-Session-R1:0xABC",
    jobId: "wiki-job-r1",
    marker: "session-round-trip"
  });
  await stateStore.putWorkReceiptDocument(document.sessionId, document);
  const first = makeHarness({ stateStore });

  await first.route({
    request: { method: "GET" },
    response: first.response,
    url: new URL("http://localhost/receipts/wiki-session-r1%3A0xabc"),
    pathname: "/receipts/wiki-session-r1%3A0xabc"
  });

  assert.equal(first.response.statusCode, 301);
  assert.equal(first.response.headers.location, `/receipts/${document.receiptId}`);
  const second = makeHarness({ stateStore });
  await second.route({
    request: { method: "GET" },
    response: second.response,
    url: new URL(`http://localhost${first.response.headers.location}`),
    pathname: first.response.headers.location
  });
  assert.equal(second.response.statusCode, 200);
  assert.equal(second.response.body.document.receiptId, document.receiptId);
  assert.equal(second.response.body.document.marker, "session-round-trip");
});

test("GET /receipts job alias redirects to the selected canonical receipt", async () => {
  const stateStore = new MemoryStateStore();
  const document = addressedWorkReceipt({
    sessionId: "session-job-alias",
    jobId: "Catalog-Job-R7",
    marker: "job-round-trip"
  });
  await stateStore.putWorkReceiptDocument(document.sessionId, document);
  const { response, route } = makeHarness({ stateStore });
  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/receipts/catalog-job-r7"),
    pathname: "/receipts/catalog-job-r7"
  });
  assert.equal(response.statusCode, 301);
  assert.equal(response.headers.location, `/receipts/${document.receiptId}`);
});

test("GET /receipts returns not_found after exact, session, and job alias misses", async () => {
  const { response, route } = makeHarness({ stateStore: {} });
  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/receipts/session-1"),
    pathname: "/receipts/session-1"
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", kind: "work", id: "session-1" });
});

test("listBadgeReceipts keeps the persisted signature only on the canonical document", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-11T00:00:00.000Z" };
  const signedBadge = { ...STORED_BADGE, signature };
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new Error("must not rebuild"); },
    deriveBadgeLineage: () => undefined,
    service: { listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }] },
    stateStore: { getBadgeDocument: async () => signedBadge },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const { items: [receipt] } = await listBadgeReceipts({ limit: 100 });
  assert.equal(Object.hasOwn(receipt, "signature"), false);
  assert.deepEqual(receipt.document.signature, signature);
});

test("listBadgeReceipts emits run and badge rows for an approved session", async () => {
  const runSignature = { alg: "ES256", kid: "badge-1", sig: "run..signature", signedAt: "2026-07-12T00:00:00.000Z" };
  const badgeSignature = { alg: "ES256", kid: "badge-1", sig: "badge..signature", signedAt: "2026-07-12T00:00:01.000Z" };
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new Error("must not rebuild"); },
    deriveBadgeLineage: () => undefined,
    service: { listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }] },
    stateStore: {
      getRunReceiptDocument: async () => ({
        ...STORED_RUN_RECEIPT,
        verdict: { ...STORED_RUN_RECEIPT.verdict, outcome: "approved", reasonCode: "OK" },
        signature: runSignature
      }),
      getBadgeDocument: async () => ({ ...STORED_BADGE, signature: badgeSignature })
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const { items: receipts } = await listBadgeReceipts({ limit: 100 });
  assert.deepEqual(receipts.map((receipt) => receipt.unsignedPresentation.kind), ["run", "badge"]);
  assert.equal(receipts[0].unsignedPresentation.verdict, "approved");
  assert.equal(receipts[0].unsignedPresentation.result, "PASS");
  assert.equal(receipts[0].unsignedPresentation.assetContext.chainName, "Polkadot Hub");
  assert.equal(Object.hasOwn(receipts[0].document, "result"), false, "signed receipt remains canonical");
  assert.deepEqual(receipts[0].document.signature, runSignature);
  assert.deepEqual(receipts[1].document.signature, badgeSignature);
});

test("listBadgeReceipts emits only a run row for a rejected session", async () => {
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new NotFoundError("No badge", "badge_not_ready"); },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned", status: "rejected" }],
      getJobDefinition: () => { throw new Error("Unknown job"); }
    },
    stateStore: {
      getRunReceiptDocument: async () => STORED_RUN_RECEIPT,
      getBadgeDocument: async () => undefined
    },
    verifierService: { getResult: async () => ({ outcome: "rejected" }) }
  });

  const { items: receipts } = await listBadgeReceipts({ limit: 100 });
  assert.deepEqual(receipts.map((receipt) => receipt.unsignedPresentation.kind), ["run"]);
  assert.equal(receipts[0].unsignedPresentation.verdict, "rejected");
  assert.equal(receipts[0].unsignedPresentation.result, "FAIL");
});

test("listBadgeReceipts includes a stored badge without looking up its pruned job", async () => {
  let jobLookups = 0;
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => {
      throw new Error("stored badges must not rebuild");
    },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }],
      getJobDefinition: () => {
        jobLookups += 1;
        throw new Error("Unknown job");
      }
    },
    stateStore: {
      getBadgeDocument: async () => STORED_BADGE
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const { items: receipts } = await listBadgeReceipts({ limit: 100 });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].unsignedPresentation.sessionId, "session-pruned");
  assert.deepEqual(receipts[0].document, STORED_BADGE);
  assert.equal(jobLookups, 0);
});

test("listBadgeReceipts isolates a row whose job lookup cannot be rebuilt", async () => {
  const sessions = [
    { sessionId: "session-pruned", jobId: "job-pruned" },
    { sessionId: "session-live", jobId: "job-live" }
  ];
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: ({ session, job }) => {
      if (!job) throw new Error("missing job facts");
      return {
        averray: {
          sessionId: session.sessionId,
          jobId: session.jobId,
          worker: "0x3333333333333333333333333333333333333333"
        },
        signers: SIGNERS
      };
    },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => sessions,
      getJobDefinition: (jobId) => {
        if (jobId === "job-pruned") throw new Error("Unknown job");
        return JOB;
      }
    },
    stateStore: {
      getBadgeDocument: async () => undefined,
      putBadgeDocument: async (_sessionId, badge) => badge
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const { items: receipts } = await listBadgeReceipts({ limit: 100 });
  assert.deepEqual(receipts.map((receipt) => receipt.unsignedPresentation.sessionId), ["session-live"]);
});

test("served list-item schema and signatures verify; mixed-kind cursor pages return 400 rows exactly once and ETag changes", async () => {
  const schema = JSON.parse(readFileSync(new URL("../../../../docs/schemas/badge-list-item-v1.json", import.meta.url), "utf8"));
  const validateItem = new Ajv().compile(schema);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), alg: "ES256", kid: "badge-1" };
  function signed(document) {
    const signedAt = "2026-10-08T12:00:00.000Z";
    const header = { alg: "ES256", kid: jwk.kid, signedAt, typ: "averray-badge-receipt+jws" };
    const protectedPart = Buffer.from(JSON.stringify(header)).toString("base64url");
    const input = `${protectedPart}.${canonicalBadgeReceiptBytes(document).toString("base64url")}`;
    const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { ...document, signature: { alg: "ES256", kid: jwk.kid, signedAt, sig: `${protectedPart}..${sig}` } };
  }
  const sessions = Array.from({ length: 200 }, (_, i) => ({ sessionId: `fixture-${i}`, jobId: `job-${i}` }));
  const badges = new Map(sessions.map((session) => [session.sessionId, signed({
    ...STORED_BADGE, averray: { ...STORED_BADGE.averray, ...session }
  })]));
  const runs = new Map(sessions.map((session) => [session.sessionId, signed({ ...STORED_RUN_RECEIPT, ...session })]));
  const stateStore = {
    listRecentSessions: async (limit, offset) => sessions.slice(offset, offset + limit),
    getBadgeDocument: async (id) => badges.get(id),
    getRunReceiptDocument: async (id) => runs.get(id)
  };
  const list = createLister({ stateStore, service: {}, verifierService: {} });
  const h = makeHarness({ listBadgeReceipts: list });
  async function get(query = "", headers = {}) {
    const response = {};
    await h.route({ request: { method: "GET", headers }, response,
      url: new URL(`http://localhost/badges${query}`), pathname: "/badges" });
    return response;
  }
  const first = await get();
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.limit, 50);
  assert.equal((await get("", { "if-none-match": first.headers.etag })).statusCode, 304);
  assert.match(first.headers.link, /rel="next"/u);
  let cursor;
  const seen = new Set();
  const boundaryKinds = new Set();
  let badgeCount = 0;
  do {
    // Every session has BOTH rows; odd pages alternate badge/run boundaries.
    const limit = cursor ? 17 : 1;
    const response = await get(`?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.items.length <= limit);
    for (const item of response.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ["document", "schemaVersion", "unsignedPresentation"]);
      assert.equal(validateItem(item), true, JSON.stringify(validateItem.errors));
      assert.equal(verifyBadgeReceiptSignature(item.document, jwk), true, "signed document verifies exactly as served");
      assert.equal(Object.hasOwn(item.document, "result"), false);
      const identity = `${item.unsignedPresentation.sessionId}:${item.unsignedPresentation.kind}`;
      assert.equal(seen.has(identity), false, identity);
      seen.add(identity);
      if (item.unsignedPresentation.kind === "badge") badgeCount++;
    }
    cursor = response.body.nextCursor;
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
      const last = response.body.items.at(-1).unsignedPresentation;
      assert.equal(decoded.sessionId, last.sessionId);
      assert.equal(decoded.kind, last.kind);
      boundaryKinds.add(decoded.kind);
    }
  } while (cursor);
  assert.equal(badgeCount, 200);
  assert.equal(seen.size, 400);
  assert.deepEqual([...boundaryKinds].sort(), ["badge", "run"]);
  badges.set(sessions[0].sessionId, signed({ ...badges.get(sessions[0].sessionId), name: "newest row changed", signature: undefined }));
  const changed = await get("", { "if-none-match": first.headers.etag });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  await assert.rejects(get("?cursor=broken"), { code: "invalid_request", statusCode: 400 });
  const missing = Buffer.from(JSON.stringify({ v: 1, sessionId: "deleted", kind: "badge" })).toString("base64url");
  await assert.rejects(get(`?cursor=${missing}`), { code: "invalid_request", statusCode: 400 });
});
