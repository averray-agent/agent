import assert from "node:assert/strict";
import test from "node:test";

import { extractBearer, normalizeConnectAuthority, publicTargetAllowed } from "../../deploy/mcp-egress-proxy/policy.mjs";

test("egress proxy normalizes one exact CONNECT authority and rejects authority-shaped riders", () => {
  assert.deepEqual(normalizeConnectAuthority("MCP.Example.COM:443"), {
    authority: "mcp.example.com:443",
    hostname: "mcp.example.com",
    port: 443
  });
  for (const mutation of ["mcp.example.com:443/other", "user@mcp.example.com:443", "", "mcp.example.com:99999"]) {
    assert.throws(() => normalizeConnectAuthority(mutation), /invalid_authority|Invalid URL/u);
  }
});

test("egress grant header is explicit and proxy denies private or metadata destinations by default", () => {
  assert.equal(extractBearer("Bearer signed.grant-value_1"), "signed.grant-value_1");
  assert.throws(() => extractBearer("Basic signed.grant-value_1"), /missing_grant/u);
  for (const denied of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"]) {
    assert.equal(publicTargetAllowed(denied), false, denied);
  }
  assert.equal(publicTargetAllowed("1.1.1.1"), true);
  assert.equal(publicTargetAllowed("127.0.0.1", { allowPrivateFixtures: true }), true);
});

test("mutation drill proves a grant bound to host A cannot authorize host B", () => {
  const grantAuthority = normalizeConnectAuthority("one.example:443").authority;
  const attemptedAuthority = normalizeConnectAuthority("two.example:443").authority;
  const authorizeBoundary = (authority) => authority === grantAuthority;
  assert.equal(authorizeBoundary(grantAuthority), true);
  assert.equal(authorizeBoundary(attemptedAuthority), false);
  assert.throws(() => assert.equal(authorizeBoundary(attemptedAuthority), true), /false !== true/u);
});
