import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, ValidationError } from "./errors.js";
import {
  issueShareToken,
  normalizeShareSurface,
  verifyShareToken
} from "./share-links.js";

const SECRET = "share-link-test-secret-with-at-least-32-bytes";
const NOW = new Date("2026-05-30T12:00:00.000Z");

test("normalizeShareSurface accepts canonical names and operator aliases", () => {
  assert.equal(normalizeShareSurface("agent_profile"), "agent");
  assert.equal(normalizeShareSurface("session_audit"), "session");
  assert.equal(normalizeShareSurface("dispute_snapshot"), "dispute");
  assert.equal(normalizeShareSurface("policy_snapshot"), "policy");
});

test("issueShareToken signs read-only share payloads with expiry", () => {
  const issued = issueShareToken({
    surface: "session",
    id: "session-1",
    ttlSeconds: 60,
    secret: SECRET,
    now: NOW
  });

  assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.deepEqual(issued.payload, {
    v: 1,
    surface: "session",
    id: "session-1",
    issuedAt: "2026-05-30T12:00:00.000Z",
    expiresAt: "2026-05-30T12:01:00.000Z"
  });

  assert.deepEqual(verifyShareToken(issued.token, {
    secret: SECRET,
    now: new Date("2026-05-30T12:00:30.000Z")
  }), issued.payload);
});

test("verifyShareToken rejects tampering and expiry", () => {
  const issued = issueShareToken({
    surface: "policy",
    id: "ops/sample@v1",
    ttlSeconds: 60,
    secret: SECRET,
    now: NOW
  });

  assert.throws(
    () => verifyShareToken(`${issued.token.slice(0, -1)}x`, { secret: SECRET, now: NOW }),
    AuthorizationError
  );
  assert.throws(
    () => verifyShareToken(issued.token, {
      secret: SECRET,
      now: new Date("2026-05-30T12:01:00.000Z")
    }),
    (error) => error instanceof AuthorizationError && error.code === "share_token_expired"
  );
});

test("issueShareToken validates surface, id, and issue time", () => {
  assert.throws(
    () => issueShareToken({ surface: "unknown", id: "x", secret: SECRET, now: NOW }),
    ValidationError
  );
  assert.throws(
    () => issueShareToken({ surface: "session", id: "", secret: SECRET, now: NOW }),
    ValidationError
  );
  assert.throws(
    () => issueShareToken({ surface: "session", id: "x", secret: SECRET, now: new Date("nope") }),
    ValidationError
  );
});
