import assert from "node:assert/strict";
import test from "node:test";

import { renderCutover, routeState } from "./render-caddy-cutover.mjs";

const TESTNET = `api.averray.com {\n  reverse_proxy backend:8787\n}\nindex.averray.com {\n  reverse_proxy indexer:42069\n}\n`;

test("renders a pure mainnet route and rolls back exactly", () => {
  const mainnet = renderCutover(TESTNET, "mainnet");
  assert.equal(routeState(mainnet), "mainnet");
  assert.match(mainnet, /mainnet-backend:8787/u);
  assert.match(mainnet, /mainnet-indexer:42069/u);
  assert.equal(renderCutover(mainnet, "testnet"), TESTNET);
});

test("is idempotent in the requested state", () => {
  assert.equal(renderCutover(TESTNET, "testnet"), TESTNET);
});

test("refuses mixed and unknown routing", () => {
  assert.throws(() => renderCutover(`${TESTNET}\nreverse_proxy mainnet-backend:8787\n`, "mainnet"), /mixed/u);
  assert.throws(() => renderCutover("respond 200\n", "mainnet"), /unknown/u);
  assert.throws(() => renderCutover("reverse_proxy backend:8787\n", "mainnet"), /incomplete/u);
});
