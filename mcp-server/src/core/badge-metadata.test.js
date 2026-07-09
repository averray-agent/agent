import test from "node:test";
import assert from "node:assert/strict";

import {
  BADGE_SCHEMA_VERSION,
  UNKNOWN_ADDRESS,
  buildBadgeFromSession,
  buildBadgeMetadata,
  buildBadgeSigners,
  validateBadgeMetadata
} from "./badge-metadata.js";
import { NotFoundError, ValidationError } from "./errors.js";

// Factory so each test gets a fresh deep copy. `buildBadgeMetadata` and the
// validator share object references with the input — which is fine for
// production but causes test isolation bugs if one test's mutation leaks
// into another's shared fixture.
function validInput() {
  return {
    jobId: "starter-coding-001",
    chainJobId: "0xa57b4a1f00000000000000000000000000000000000000000000000000000000",
    sessionId: "session-0x1234-starter-coding-001-1700000000000",
    category: "coding",
    level: 1,
    verifierMode: "benchmark",
    reward: { asset: "DOT", amount: "5000000000000000000", decimals: 18 },
    claimStake: { asset: "DOT", amount: "250000000000000000", decimals: 18 },
    evidenceHash: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
    completedAt: "2026-04-16T14:30:00.000Z",
    worker: "0x1234567890123456789012345678901234567890",
    poster: "0x0987654321098765432109876543210987654321",
    verifier: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  };
}

test("buildBadgeMetadata produces a schema-valid document", () => {
  const doc = buildBadgeMetadata(validInput());
  assert.equal(doc.averray.schemaVersion, BADGE_SCHEMA_VERSION);
  assert.equal(doc.averray.category, "coding");
  assert.equal(doc.averray.level, 1);
  assert.equal(doc.external_url, `https://averray.com/agents/${validInput().worker}`);
  assert.deepEqual(doc.attributes, [
    { trait_type: "Category", value: "coding" },
    { trait_type: "Level", value: 1 },
    { trait_type: "Verifier", value: "benchmark" }
  ]);
});

test("buildBadgeMetadata uses publicBaseUrl when supplied", () => {
  const doc = buildBadgeMetadata({ ...validInput(), publicBaseUrl: "https://app.example.com/" });
  assert.equal(doc.external_url, `https://app.example.com/agents/${validInput().worker}`);
});

test("buildBadgeMetadata adds image + metadataURI when provided", () => {
  const doc = buildBadgeMetadata({
    ...validInput(),
    image: "https://averray.com/badges/coding-1.svg",
    metadataURI: "https://api.averray.com/badges/session-xyz"
  });
  assert.equal(doc.image, "https://averray.com/badges/coding-1.svg");
  assert.equal(doc.averray.metadataURI, "https://api.averray.com/badges/session-xyz");
});

test("validateBadgeMetadata accepts a compliant document", () => {
  const doc = buildBadgeMetadata(validInput());
  assert.equal(validateBadgeMetadata(doc), doc);
});

test("validateBadgeMetadata rejects wrong schemaVersion", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.schemaVersion = "v2";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /schemaVersion/.test(err.message));
});

test("validateBadgeMetadata rejects malformed address", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.worker = "0xnot-a-real-address";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /worker/.test(err.message));
});

test("validateBadgeMetadata rejects float amount", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.reward.amount = "5.0";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /reward\.amount/.test(err.message));
});

test("validateBadgeMetadata rejects unknown averray field", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.extraField = "surprise";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /extraField/.test(err.message));
});

test("validateBadgeMetadata rejects out-of-range level", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.level = 0;
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /level/.test(err.message));
});

test("validateBadgeMetadata rejects invalid verifierMode", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.verifierMode = "llm_judge";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /verifierMode/.test(err.message));
});

test("validateBadgeMetadata rejects malformed evidenceHash", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.evidenceHash = "0x123";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /evidenceHash/.test(err.message));
});

test("validateBadgeMetadata rejects non-ISO completedAt", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.completedAt = "yesterday";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /completedAt/.test(err.message));
});

test("validateBadgeMetadata rejects missing attributes", () => {
  const doc = buildBadgeMetadata(validInput());
  delete doc.attributes;
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /attributes/.test(err.message));
});

test("validateBadgeMetadata rejects non-https external_url", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.external_url = "not-a-url";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /external_url/.test(err.message));
});

test("validateBadgeMetadata rejects missing amount.decimals", () => {
  const doc = buildBadgeMetadata(validInput());
  delete doc.averray.reward.decimals;
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /decimals/.test(err.message));
});

test("validateBadgeMetadata rejects extra field on amount", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.reward.surprise = "ooh";
  assert.throws(() => validateBadgeMetadata(doc), (err) => err instanceof ValidationError && /reward\.surprise/.test(err.message));
});

// ---------------------------------------------------------------------------
// buildBadgeFromSession — adapts in-memory session/job/verification state
// into a schema-compliant document with documented placeholder fields.
// ---------------------------------------------------------------------------

function approvedSessionFixture() {
  return {
    session: {
      sessionId: "session-0x1234-starter-coding-001-1700000000000",
      wallet: "0x1234567890123456789012345678901234567890",
      jobId: "starter-coding-001",
      chainJobId: "0xa57b4a1f00000000000000000000000000000000000000000000000000000000",
      claimStake: 0.25,
      claimStakeBps: 500,
      status: "resolved",
      protocolHistory: ["http"],
      claimedAt: "2026-04-16T14:00:00.000Z",
      submittedAt: "2026-04-16T14:12:00.000Z",
      resolvedAt: "2026-04-16T14:29:00.000Z",
      updatedAt: "2026-04-16T14:30:00.000Z"
    },
    job: {
      id: "starter-coding-001",
      category: "coding",
      tier: "starter",
      rewardAsset: "DOT",
      rewardAmount: 5,
      verifierMode: "benchmark"
    },
    verification: { outcome: "approved", reasonCode: "OK", resolvedAt: "2026-04-16T14:29:00.000Z" },
    context: {
      publicBaseUrl: "https://api.averray.com",
      posterAddress: "0x0987654321098765432109876543210987654321",
      verifierAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    }
  };
}

test("buildBadgeFromSession produces a valid v1 document", () => {
  const doc = buildBadgeFromSession(approvedSessionFixture());
  assert.equal(doc.averray.schemaVersion, BADGE_SCHEMA_VERSION);
  assert.equal(doc.averray.sessionId, "session-0x1234-starter-coding-001-1700000000000");
  assert.equal(doc.averray.reward.amount, "5000000000000000000"); // 5 DOT at 18 decimals
  assert.equal(doc.averray.claimStake.amount, "250000000000000000"); // 0.25 DOT at 18 decimals
  assert.equal(
    doc.averray.metadataURI,
    "https://api.averray.com/badges/session-0x1234-starter-coding-001-1700000000000"
  );
  assert.equal(doc.averray.verifierMode, "benchmark");
  assert.deepEqual(doc.signers, [
    {
      role: "operator",
      wallet: "0x0987654321098765432109876543210987654321",
      at: "2026-04-16T14:00:00.000Z",
      status: "posted"
    },
    {
      role: "verifier",
      wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      at: "2026-04-16T14:29:00.000Z",
      status: "signed"
    },
    {
      role: "worker",
      wallet: "0x1234567890123456789012345678901234567890",
      at: "2026-04-16T14:12:00.000Z",
      status: "submitted"
    }
  ]);
  // Validator round-trips
  assert.doesNotThrow(() => validateBadgeMetadata(doc));
});

test("buildBadgeFromSession rejects sessions that aren't approved", () => {
  const fixture = approvedSessionFixture();
  fixture.session.status = "submitted";
  fixture.verification.outcome = "pending";
  assert.throws(
    () => buildBadgeFromSession(fixture),
    (err) => err instanceof NotFoundError && err.code === "badge_not_ready"
  );
});

test("buildBadgeFromSession accepts approved outcome even without resolved status", () => {
  const fixture = approvedSessionFixture();
  fixture.session.status = "submitted";
  fixture.verification.outcome = "approved";
  // Should not throw — an approved verdict is enough to mint a badge
  const doc = buildBadgeFromSession(fixture);
  assert.equal(doc.averray.schemaVersion, BADGE_SCHEMA_VERSION);
});

test("buildBadgeFromSession synthesises a chainJobId when missing", () => {
  const fixture = approvedSessionFixture();
  delete fixture.session.chainJobId;
  const doc = buildBadgeFromSession(fixture);
  assert.match(doc.averray.chainJobId, /^0x[a-fA-F0-9]{64}$/u);
});

test("buildBadgeFromSession rejects a session without a valid wallet", () => {
  const fixture = approvedSessionFixture();
  fixture.session.wallet = "not-an-address";
  assert.throws(
    () => buildBadgeFromSession(fixture),
    (err) => err instanceof ValidationError && /session\.wallet/.test(err.message)
  );
});

test("buildBadgeFromSession milestone jobs earn level 2", () => {
  const fixture = approvedSessionFixture();
  fixture.job.payoutMode = "milestone";
  const doc = buildBadgeFromSession(fixture);
  assert.equal(doc.averray.level, 2);
});

test("buildBadgeFromSession returns 404-ish error for unknown session", () => {
  assert.throws(
    () => buildBadgeFromSession({ session: undefined, job: undefined }),
    (err) => err instanceof NotFoundError && err.code === "session_not_found"
  );
});

test("buildBadgeFromSession emits UNKNOWN_ADDRESS for poster/verifier when context is missing", () => {
  const fixture = approvedSessionFixture();
  // Drop the operator-supplied addresses so the adapter has to fall back.
  fixture.context = { publicBaseUrl: "https://api.averray.com" };
  const doc = buildBadgeFromSession(fixture);
  assert.equal(doc.averray.poster, UNKNOWN_ADDRESS);
  assert.equal(doc.averray.verifier, UNKNOWN_ADDRESS);
  assert.deepEqual(doc.signers, [
    {
      role: "worker",
      wallet: "0x1234567890123456789012345678901234567890",
      at: "2026-04-16T14:12:00.000Z",
      status: "submitted"
    }
  ]);
  // The worker stays authoritative — it's always session.wallet.
  assert.equal(doc.averray.worker, fixture.session.wallet.toLowerCase());
});

test("buildBadgeFromSession never attributes poster/verifier back to the worker", () => {
  // Regression: the previous fallback was `context.posterAddress ??
  // session.wallet`, which produced badges that falsely claimed the worker
  // posted and verified their own job. If this test ever passes again
  // with poster == worker, that bug has regressed.
  const fixture = approvedSessionFixture();
  delete fixture.context.posterAddress;
  delete fixture.context.verifierAddress;
  const doc = buildBadgeFromSession(fixture);
  assert.notEqual(doc.averray.poster, doc.averray.worker);
  assert.notEqual(doc.averray.verifier, doc.averray.worker);
});

test("buildBadgeSigners omits entries missing identity or timestamp", () => {
  const fixture = approvedSessionFixture();
  delete fixture.session.submittedAt;
  delete fixture.session.resolvedAt;
  fixture.verification = { outcome: "approved" };
  fixture.context.verifierAddress = UNKNOWN_ADDRESS;

  const signers = buildBadgeSigners(fixture);

  assert.deepEqual(signers, [
    {
      role: "operator",
      wallet: "0x0987654321098765432109876543210987654321",
      at: "2026-04-16T14:00:00.000Z",
      status: "posted"
    }
  ]);
  assert.ok(signers.every((signer) => signer.wallet !== UNKNOWN_ADDRESS));
});

test("buildBadgeMetadata accepts an optional lineage block (parent only)", () => {
  const doc = buildBadgeMetadata({
    ...validInput(),
    lineage: {
      parent: {
        sessionId: "remote-session",
        jobId: "remote-job",
        wallet: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }
    }
  });
  assert.deepEqual(doc.averray.lineage, {
    parent: {
      sessionId: "remote-session",
      jobId: "remote-job",
      wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  });
});

test("buildBadgeMetadata accepts a children-only lineage block and derives count from jobIds", () => {
  const doc = buildBadgeMetadata({
    ...validInput(),
    lineage: {
      children: { jobIds: ["child-1", "child-2"] }
    }
  });
  assert.deepEqual(doc.averray.lineage, {
    children: { count: 2, jobIds: ["child-1", "child-2"] }
  });
});

test("buildBadgeMetadata omits the lineage block when nothing meaningful was supplied", () => {
  const doc = buildBadgeMetadata({ ...validInput(), lineage: { parent: {} } });
  assert.equal("lineage" in doc.averray, false);
});

test("validateBadgeMetadata rejects an unknown lineage subfield", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.lineage = { parent: { sessionId: "s1", rogue: "x" } };
  assert.throws(() => validateBadgeMetadata(doc), ValidationError);
});

test("validateBadgeMetadata rejects a malformed parent wallet", () => {
  const doc = buildBadgeMetadata(validInput());
  doc.averray.lineage = { parent: { wallet: "not-a-wallet" } };
  assert.throws(() => validateBadgeMetadata(doc), ValidationError);
});
