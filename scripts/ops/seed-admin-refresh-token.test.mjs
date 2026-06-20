import test from "node:test";
import assert from "node:assert/strict";

import { seedAdminRefreshToken } from "./seed-admin-refresh-token.mjs";

// Fake fetch keyed by request path. Each entry: { status, body, setCookie?: string[] }.
function makeFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const setCookie = route.setCookie ?? [];
    return {
      status: route.status,
      headers: {
        getSetCookie: () => setCookie,
        get: (name) => (name.toLowerCase() === "set-cookie" ? setCookie[0] ?? null : null),
      },
      text: async () => JSON.stringify(route.body ?? {}),
    };
  };
}

const fakeWallet = {
  address: "0xAdmin000000000000000000000000000000A1",
  signMessage: async () => "0xsignature",
};

const happyRoutes = {
  "/auth/nonce": { status: 200, body: { message: "siwe-message-to-sign" } },
  "/auth/verify": {
    status: 200,
    body: { token: "header.payload.sig", roles: ["admin", "verifier"] },
    setCookie: ["refresh_token=REFRESH-123; Path=/; HttpOnly; Secure"],
  },
};

test("SIWE login captures the refresh cookie and writes the target item", async () => {
  const writes = [];
  const result = await seedAdminRefreshToken({
    item: "op://prod-smoke/admin-refresh-token-schema-proof/password",
    fetchImpl: makeFetch(happyRoutes),
    readSecretImpl: async () => "0xPRIVATEKEY",
    writeItemImpl: async (ref, value) => {
      writes.push({ ref, value });
      return "created";
    },
    makeWallet: () => fakeWallet,
    log: () => {},
  });

  assert.equal(result.written, true);
  assert.equal(result.refreshToken, "REFRESH-123");
  assert.equal(result.action, "created");
  assert.deepEqual(result.roles, ["admin", "verifier"]);
  assert.deepEqual(writes, [
    { ref: "op://prod-smoke/admin-refresh-token-schema-proof/password", value: "REFRESH-123" },
  ]);
});

test("--dry-run returns the cookie and never writes", async () => {
  let wrote = false;
  const result = await seedAdminRefreshToken({
    dryRun: true,
    fetchImpl: makeFetch(happyRoutes),
    readSecretImpl: async () => "0xPRIVATEKEY",
    writeItemImpl: async () => {
      wrote = true;
      return "edited";
    },
    makeWallet: () => fakeWallet,
    log: () => {},
  });

  assert.equal(result.written, false);
  assert.equal(result.refreshToken, "REFRESH-123");
  assert.equal(wrote, false);
});

test("a roleless login is rejected (would mint useless tokens)", async () => {
  await assert.rejects(
    () =>
      seedAdminRefreshToken({
        item: "op://prod-smoke/x/password",
        fetchImpl: makeFetch({
          ...happyRoutes,
          "/auth/verify": {
            status: 200,
            body: { token: "a.b.c", roles: [] },
            setCookie: ["refresh_token=X"],
          },
        }),
        readSecretImpl: async () => "0xPRIVATEKEY",
        writeItemImpl: async () => "edited",
        makeWallet: () => fakeWallet,
        log: () => {},
      }),
    /ROLELESS/u,
  );
});

test("a verify response with no refresh cookie is a clear error", async () => {
  await assert.rejects(
    () =>
      seedAdminRefreshToken({
        item: "op://prod-smoke/x/password",
        fetchImpl: makeFetch({
          ...happyRoutes,
          "/auth/verify": {
            status: 200,
            body: { token: "a.b.c", roles: ["admin"] },
            setCookie: [],
          },
        }),
        readSecretImpl: async () => "0xPRIVATEKEY",
        writeItemImpl: async () => "edited",
        makeWallet: () => fakeWallet,
        log: () => {},
      }),
    /no refresh_token cookie/u,
  );
});

test("write mode requires --item", async () => {
  await assert.rejects(
    () =>
      seedAdminRefreshToken({
        fetchImpl: makeFetch(happyRoutes),
        readSecretImpl: async () => "0xPRIVATEKEY",
        makeWallet: () => fakeWallet,
        log: () => {},
      }),
    /--item .* is required/u,
  );
});

test("a non-200 from /auth/verify surfaces the status and body", async () => {
  await assert.rejects(
    () =>
      seedAdminRefreshToken({
        item: "op://prod-smoke/x/password",
        fetchImpl: makeFetch({
          ...happyRoutes,
          "/auth/verify": { status: 401, body: { error: "bad_signature" } },
        }),
        readSecretImpl: async () => "0xPRIVATEKEY",
        writeItemImpl: async () => "edited",
        makeWallet: () => fakeWallet,
        log: () => {},
      }),
    /HTTP 401.*bad_signature/u,
  );
});
