import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ADMIN_REFRESH_TOKEN_OP,
  extractRefreshCookie,
  getAdminRefreshToken,
  parseOpRef,
  resolveRefreshCredential
} from "./get-admin-refresh-token.mjs";

test("getAdminRefreshToken exchanges refresh cookie and persists the rotated cookie", async () => {
  const calls = [];
  const result = await getAdminRefreshToken({
    env: {
      API_BASE_URL: "https://api.example.test",
      ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password"
    },
    async readSecretImpl(ref) {
      calls.push(["read", ref]);
      return "refresh-old";
    },
    async writeSecretImpl(ref, value) {
      calls.push(["write", ref, value]);
    },
    async fetchImpl(url, options) {
      calls.push(["fetch", url, options.headers.cookie]);
      assert.equal(url, "https://api.example.test/auth/refresh");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.cookie, "refresh_token=refresh-old");
      return jsonResponse(
        200,
        {
          token: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIwMTIzIn0.signature",
          wallet: "0x1111111111111111111111111111111111111111",
          roles: ["admin", "verifier"],
          expiresAt: "2026-05-26T12:15:00.000Z",
          tokenType: "Bearer"
        },
        { "set-cookie": "refresh_token=refresh-new; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh" }
      );
    }
  });

  assert.equal(result.accessToken, "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIwMTIzIn0.signature");
  assert.equal(result.credentialSource, "op://prod-smoke/admin-refresh-token/password");
  assert.equal(result.writeBackRef, "op://prod-smoke/admin-refresh-token/password");
  assert.equal(result.rotatedRefreshTokenPersisted, true);
  assert.deepEqual(calls, [
    ["read", "op://prod-smoke/admin-refresh-token/password"],
    ["fetch", "https://api.example.test/auth/refresh", "refresh_token=refresh-old"],
    ["write", "op://prod-smoke/admin-refresh-token/password", "refresh-new"]
  ]);
});

test("getAdminRefreshToken surfaces refresh replay detection without writing a token", async () => {
  const writes = [];
  await assert.rejects(
    getAdminRefreshToken({
      env: { ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password" },
      async readSecretImpl() {
        return "refresh-old";
      },
      async writeSecretImpl(...args) {
        writes.push(args);
      },
      async fetchImpl() {
        return jsonResponse(401, {
          error: "refresh_replay_detected",
          message: "refresh: refresh_replay_detected",
          requestId: "request-replay"
        });
      }
    }),
    (error) => {
      assert.equal(error.name, "AdminRefreshTokenError");
      assert.equal(error.status, 401);
      assert.equal(error.code, "refresh_replay_detected");
      assert.match(error.message, /refresh_replay_detected/u);
      assert.match(error.message, /request-replay/u);
      return true;
    }
  );
  assert.deepEqual(writes, []);
});

test("getAdminRefreshToken surfaces expired refresh tokens", async () => {
  await assert.rejects(
    getAdminRefreshToken({
      env: { ADMIN_REFRESH_TOKEN: "expired-refresh-token" },
      async fetchImpl() {
        return jsonResponse(401, {
          error: "refresh_expired",
          message: "refresh: refresh_expired",
          requestId: "request-expired"
        });
      }
    }),
    (error) => {
      assert.equal(error.code, "refresh_expired");
      assert.match(error.message, /refresh_expired/u);
      assert.match(error.message, /request-expired/u);
      return true;
    }
  );
});

test("getAdminRefreshToken fails closed when refresh succeeds but rotated cookie is missing", async () => {
  await assert.rejects(
    getAdminRefreshToken({
      env: { ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password" },
      async readSecretImpl() {
        return "refresh-old";
      },
      async writeSecretImpl() {
        throw new Error("should not write without a rotated cookie");
      },
      async fetchImpl() {
        return jsonResponse(200, { token: "access-token" });
      }
    }),
    /did not return a rotated refresh cookie/u
  );
});

test("resolveRefreshCredential supports default OP source, raw token, and disabled write-back", async () => {
  const defaultCredential = await resolveRefreshCredential({
    env: {},
    async readSecretImpl(ref) {
      assert.equal(ref, DEFAULT_ADMIN_REFRESH_TOKEN_OP);
      return "default-refresh";
    }
  });
  assert.equal(defaultCredential.refreshToken, "default-refresh");
  assert.equal(defaultCredential.source, DEFAULT_ADMIN_REFRESH_TOKEN_OP);
  assert.equal(defaultCredential.writeBackRef, DEFAULT_ADMIN_REFRESH_TOKEN_OP);

  const rawCredential = await resolveRefreshCredential({
    env: { ADMIN_REFRESH_TOKEN: "raw-refresh" }
  });
  assert.equal(rawCredential.refreshToken, "raw-refresh");
  assert.equal(rawCredential.source, "ADMIN_REFRESH_TOKEN");
  assert.equal(rawCredential.writeBackRef, null);

  const readOnlyCredential = await resolveRefreshCredential({
    env: {
      ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password",
      ADMIN_REFRESH_TOKEN_WRITE_BACK: "0"
    },
    async readSecretImpl() {
      return "readonly-refresh";
    }
  });
  assert.equal(readOnlyCredential.refreshToken, "readonly-refresh");
  assert.equal(readOnlyCredential.writeBackRef, null);
});

test("extractRefreshCookie and parseOpRef handle hosted refresh-cookie shapes", () => {
  const headers = new Headers({
    "set-cookie": "refresh_token=rotated-value; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh"
  });
  assert.equal(extractRefreshCookie(headers), "rotated-value");
  assert.deepEqual(parseOpRef("op://prod-smoke/admin-refresh-token/password"), {
    vault: "prod-smoke",
    item: "admin-refresh-token",
    field: "password"
  });
});

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}
