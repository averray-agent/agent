import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContentRecord,
  contentResponse,
  defaultAutoPublicAt,
  requireContentAccess,
  resolveContentAccess
} from "./content-addressed-store.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

test("buildContentRecord hashes canonical payload independent of key order", () => {
  const left = buildContentRecord({
    ownerWallet: OWNER,
    payload: { b: 2, a: 1 },
    contentType: "arbitrator_reasoning"
  });
  const right = buildContentRecord({
    ownerWallet: OWNER,
    payload: { a: 1, b: 2 },
    contentType: "arbitrator_reasoning"
  });

  assert.equal(left.hash, right.hash);
  assert.equal(left.hash.length, 66);
  assert.equal(left.contentType, "arbitrator_reasoning");
  assert.equal(left.ownerWallet, OWNER);
});

test("resolveContentAccess keeps failed reasoning owner-only until auto public", () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { rationale: "upheld" },
    contentType: "arbitrator_reasoning",
    verdict: "fail",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoPublicAt: "2026-07-01T00:00:00.000Z"
  });

  assert.equal(resolveContentAccess(record, undefined, { now: new Date("2026-02-01T00:00:00.000Z") }).allowed, false);
  assert.equal(resolveContentAccess(record, { wallet: OTHER }, { now: new Date("2026-02-01T00:00:00.000Z") }).allowed, false);
  assert.equal(resolveContentAccess(record, { wallet: OWNER }, { now: new Date("2026-02-01T00:00:00.000Z") }).allowed, true);
  assert.equal(resolveContentAccess(record, undefined, { now: new Date("2026-07-01T00:00:01.000Z") }).public, true);
});

test("passes and explicitly published content are public immediately", () => {
  const pass = buildContentRecord({
    ownerWallet: OWNER,
    payload: { rationale: "overturned" },
    contentType: "arbitrator_reasoning",
    verdict: "pass"
  });
  const published = buildContentRecord({
    ownerWallet: OWNER,
    payload: { rationale: "owner published" },
    contentType: "submission",
    verdict: "fail",
    publishedAt: "2026-01-02T00:00:00.000Z"
  });

  assert.equal(resolveContentAccess(pass).public, true);
  assert.equal(resolveContentAccess(published).public, true);
});

test("contentResponse includes the stored payload and visibility", () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { hello: "world" },
    contentType: "job_spec"
  });
  const access = requireContentAccess(record);
  const response = contentResponse(record, access);

  assert.equal(response.hash, record.hash);
  assert.equal(response.visibility, "public");
  assert.deepEqual(response.payload, { hello: "world" });
});

test("defaultAutoPublicAt is 180 days after creation", () => {
  assert.equal(
    defaultAutoPublicAt("2026-01-01T00:00:00.000Z"),
    "2026-06-30T00:00:00.000Z"
  );
});
