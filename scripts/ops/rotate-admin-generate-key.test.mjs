import assert from "node:assert/strict";
import test from "node:test";

import { buildOpItemCreateArgs } from "./rotate-admin-generate-key.mjs";

const ADDRESS = "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8";
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

test("builds op item create argv with the key as a discrete element", () => {
  const argv = buildOpItemCreateArgs({ vault: "prod-critical", title: "admin-eoa-testnet", address: ADDRESS, privateKey: PRIVATE_KEY });
  assert.deepEqual(argv.slice(0, 8), [
    "item",
    "create",
    "--vault",
    "prod-critical",
    "--category",
    "API Credential",
    "--title",
    "admin-eoa-testnet"
  ]);
  // The private key is its OWN argv element, verbatim — not embedded in a
  // shell string or composed with other fields.
  assert.ok(
    argv.includes(`private key[concealed]=${PRIVATE_KEY}`),
    "private key must be a discrete argv element"
  );
  assert.ok(argv.includes(`address[text]=${ADDRESS}`));
  assert.ok(argv.some((a) => a.startsWith("chain[text]=")));
  assert.ok(argv.some((a) => a.startsWith("notes[text]=")));
});

test("no argv element smuggles a shell substitution, placeholder, or pipe", () => {
  const argv = buildOpItemCreateArgs({ vault: "v", title: "t", address: ADDRESS, privateKey: PRIVATE_KEY });
  for (const element of argv) {
    assert.doesNotMatch(element, /\$\(/, "no $(...) command substitution");
    assert.doesNotMatch(element, /<paste|<your|<PRIVATE/i, "no placeholder-in-command");
    assert.doesNotMatch(element, /\bcat\s|[|`]/, "no cat/pipe/backtick");
  }
  // Exactly one element carries the secret, and it is the full key (so execFile
  // hands op the real value without a shell ever seeing it).
  const secretElements = argv.filter((a) => a.includes(PRIVATE_KEY));
  assert.equal(secretElements.length, 1);
});

test("refuses to build args without an address or private key", () => {
  assert.throws(() => buildOpItemCreateArgs({ vault: "v", title: "t", address: ADDRESS }), /requires/);
  assert.throws(() => buildOpItemCreateArgs({ vault: "v", title: "t", privateKey: PRIVATE_KEY }), /requires/);
});
