import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  makeRefreshStoreAdapter,
  parseCookie,
} from "./refresh-cookie.js";

import {
  REFRESH_COOKIE_NAME,
  consumeRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
} from "./refresh.js";

import { MemoryStateStore } from "../core/state-store.js";

test("parseCookie: finds the named cookie in a single-cookie header", () => {
  assert.equal(parseCookie("refresh_token=abc123", "refresh_token"), "abc123");
});

test("parseCookie: finds the named cookie among many", () => {
  const header = "session=xyz; refresh_token=abc123; csrf=def";
  assert.equal(parseCookie(header, "refresh_token"), "abc123");
});

test("parseCookie: tolerates spaces around separators", () => {
  assert.equal(parseCookie("foo=1;  refresh_token=abc;  bar=2", "refresh_token"), "abc");
});

test("parseCookie: strips surrounding double-quotes per RFC 6265", () => {
  assert.equal(parseCookie('refresh_token="abc123"', "refresh_token"), "abc123");
});

test("parseCookie: returns null for missing cookie / empty header / non-string", () => {
  assert.equal(parseCookie("", "refresh_token"), null);
  assert.equal(parseCookie("foo=bar", "refresh_token"), null);
  assert.equal(parseCookie(null, "refresh_token"), null);
  assert.equal(parseCookie(undefined, "refresh_token"), null);
  assert.equal(parseCookie("refresh_token=", "refresh_token"), null);
});

test("parseCookie: returns null when name is empty/non-string", () => {
  assert.equal(parseCookie("refresh_token=abc", ""), null);
  assert.equal(parseCookie("refresh_token=abc", null), null);
});

test("parseCookie: does not match cookies whose name STARTS with the target", () => {
  // "refresh_token_other=..." should not match a lookup for "refresh_token"
  assert.equal(parseCookie("refresh_token_other=abc", "refresh_token"), null);
});

test("buildSetCookieHeader: includes all required attributes", () => {
  const header = buildSetCookieHeader("abc123");
  assert.ok(header.startsWith(`${REFRESH_COOKIE_NAME}=abc123`), "starts with name=value");
  assert.ok(header.includes("HttpOnly"), "HttpOnly attribute present");
  assert.ok(header.includes("Secure"), "Secure attribute present");
  assert.ok(header.includes("SameSite=Strict"), "SameSite=Strict attribute present");
  assert.ok(header.includes("Path=/auth/refresh"), "Path=/auth/refresh present");
  assert.ok(/Max-Age=\d+/.test(header), "Max-Age present");
  assert.ok(!header.includes("Domain="), "Domain MUST NOT be set (host-only cookie)");
});

test("buildSetCookieHeader: honors custom maxAgeSeconds", () => {
  const header = buildSetCookieHeader("xyz", { maxAgeSeconds: 600 });
  assert.ok(header.includes("Max-Age=600"));
});

test("buildSetCookieHeader: rejects empty / non-string token", () => {
  assert.throws(() => buildSetCookieHeader(""), /non-empty string/);
  assert.throws(() => buildSetCookieHeader(null), /non-empty string/);
});

test("buildSetCookieHeader: rejects CR/LF in token (defense against header injection)", () => {
  assert.throws(() => buildSetCookieHeader("abc\r\nSet-Cookie: evil=1"), /illegal CRLF/);
  assert.throws(() => buildSetCookieHeader("abc\nfoo"), /illegal CRLF/);
});

test("buildClearCookieHeader: empties the cookie with Max-Age=0 and same attributes", () => {
  const header = buildClearCookieHeader();
  assert.ok(header.startsWith(`${REFRESH_COOKIE_NAME}=;`) || header.startsWith(`${REFRESH_COOKIE_NAME}=`));
  assert.ok(header.includes("Max-Age=0"));
  assert.ok(header.includes("HttpOnly"));
  assert.ok(header.includes("Secure"));
  assert.ok(header.includes("SameSite=Strict"));
  assert.ok(header.includes("Path=/auth/refresh"));
});

test("makeRefreshStoreAdapter: round-trips an issue → consume → rotate cycle via MemoryStateStore", async () => {
  const stateStore = new MemoryStateStore();
  const adapter = makeRefreshStoreAdapter(stateStore);

  // Issue
  const issued = await issueRefreshToken({
    wallet: "0xaaaa",
    role: "admin",
    store: adapter,
  });
  assert.ok(issued.rawToken);
  assert.equal(issued.record.wallet, "0xaaaa");

  // Confirm the state-store has it under the un-prefixed hash key
  const direct = await stateStore.getRefreshRecord(issued.hash);
  assert.ok(direct, "state-store should hold the record under the hash key");
  assert.equal(direct.wallet, "0xaaaa");

  // Consume
  const consumed = await consumeRefreshToken({ rawToken: issued.rawToken, store: adapter });
  assert.equal(consumed.record.wallet, "0xaaaa");

  // Rotate
  const rotated = await rotateRefreshToken({
    oldRecord: consumed.record,
    oldHash: consumed.hash,
    store: adapter,
  });
  assert.notEqual(rotated.rawToken, issued.rawToken);
  assert.deepEqual(rotated.record.ancestorHashes, [issued.hash]);

  // The new record exists in the state-store
  const newDirect = await stateStore.getRefreshRecord(rotated.hash);
  assert.ok(newDirect);
});

test("makeRefreshStoreAdapter: replay detection works end-to-end through the adapter", async () => {
  const stateStore = new MemoryStateStore();
  const adapter = makeRefreshStoreAdapter(stateStore);

  const t1 = await issueRefreshToken({ wallet: "0xaaaa", role: "admin", store: adapter });
  const c1 = await consumeRefreshToken({ rawToken: t1.rawToken, store: adapter });
  await rotateRefreshToken({ oldRecord: c1.record, oldHash: t1.hash, store: adapter });

  // Replay t1 — should detect, throw refresh_replay_detected, and revoke chain.
  await assert.rejects(
    () => consumeRefreshToken({ rawToken: t1.rawToken, store: adapter }),
    (err) => err.code === "refresh_replay_detected",
  );

  // Both records are revoked in the underlying state-store.
  const t1Record = await stateStore.getRefreshRecord(t1.hash);
  assert.ok(t1Record?.revokedAt, "t1 should be revoked in state-store");
});

test("makeRefreshStoreAdapter: rejects state-stores missing the new methods", () => {
  assert.throws(() => makeRefreshStoreAdapter({}), /getRefreshRecord/);
  assert.throws(
    () => makeRefreshStoreAdapter({ getRefreshRecord: () => null }),
    /upsertRefreshRecord/,
  );
});

test("makeRefreshStoreAdapter: rejects keys not in the auth:refresh: namespace", async () => {
  const stateStore = new MemoryStateStore();
  const adapter = makeRefreshStoreAdapter(stateStore);
  await assert.rejects(() => adapter.get("foo:bar"), /expected key to start with auth:refresh:/);
});
