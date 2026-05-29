import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_SITE_BASE,
  PUBLIC_PROFILE_WALLET_PATTERN,
  publicProfileUrl,
} from "./public-profile.js";

const MIXED_CASE = "0xFd2EAE2043243FDDd2721c0b42af1b8284fd6519";
const LOWER = MIXED_CASE.toLowerCase();

test("builds the canonical /agents/<wallet> URL on the public site", () => {
  assert.equal(
    publicProfileUrl(MIXED_CASE),
    `${PUBLIC_SITE_BASE}/agents/${LOWER}`,
  );
});

test("lowercases the wallet to the canonical form the shell + API use", () => {
  const url = publicProfileUrl(MIXED_CASE);
  assert.ok(url.endsWith(`/agents/${LOWER}`));
  assert.ok(!/0x[0-9a-f]*[A-F]/u.test(url)); // no uppercase hex survives
});

test("the generated path matches the deployed Caddy rewrite matcher", () => {
  // deploy/Caddyfile.averray: ^/agents/(0x[a-fA-F0-9]{40})/?$
  const caddy = /^\/agents\/(0x[a-fA-F0-9]{40})\/?$/u;
  const path = new URL(publicProfileUrl(MIXED_CASE)).pathname;
  const match = path.match(caddy);
  assert.ok(match, "URL path must match the Caddy @agentProfile matcher");
  assert.equal(match[1], LOWER);
});

test("trims surrounding whitespace before validating", () => {
  assert.equal(
    publicProfileUrl(`  ${MIXED_CASE}  `),
    `${PUBLIC_SITE_BASE}/agents/${LOWER}`,
  );
});

test("fail-closed (null) for anything that is not a 0x+40-hex address", () => {
  assert.equal(publicProfileUrl(""), null);
  assert.equal(publicProfileUrl("0x1234"), null); // too short
  assert.equal(publicProfileUrl(`${MIXED_CASE}ff`), null); // too long
  assert.equal(publicProfileUrl("0xZZZZ567890abcdef1234567890abcdef12345678"), null); // non-hex
  assert.equal(publicProfileUrl("Fd2EAE2043243FDDd2721c0b42af1b8284fd6519"), null); // missing 0x
  assert.equal(publicProfileUrl(undefined), null);
  assert.equal(publicProfileUrl(null), null);
  assert.equal(publicProfileUrl(123), null);
});

test("exported pattern accepts mixed case and rejects malformed values", () => {
  assert.equal(PUBLIC_PROFILE_WALLET_PATTERN.test(MIXED_CASE), true);
  assert.equal(PUBLIC_PROFILE_WALLET_PATTERN.test("0x1234"), false);
});
