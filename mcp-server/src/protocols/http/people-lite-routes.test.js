import assert from "node:assert/strict";
import test from "node:test";

import { PEOPLE_LITE_FIXTURE_AT, PEOPLE_LITE_FIXTURE_WALLETS } from "../../core/people-lite.js";
import { createPeopleLiteReader } from "../../services/people-lite-reader.js";
import { createPeopleLiteRoutes } from "./people-lite-routes.js";

function harness(reader = createPeopleLiteReader({ source: "fixtures" })) {
  const response = {};
  const route = createPeopleLiteRoutes({
    reader,
    respond(res, statusCode, body, headers = {}) {
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    }
  });
  return {
    response,
    async get(path) {
      const url = new URL(path, "http://localhost");
      await route({
        request: { method: "GET" },
        response,
        url,
        pathname: url.pathname
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        headers: response.headers
      };
    }
  };
}

test("GET /people/personhood/:wallet returns the three fixture tiers with pinned at", async () => {
  const { get } = harness();
  const none = await get(`/people/personhood/${PEOPLE_LITE_FIXTURE_WALLETS.none}`);
  const lite = await get(`/people/personhood/${PEOPLE_LITE_FIXTURE_WALLETS.lite}`);
  const full = await get(`/people/personhood/${PEOPLE_LITE_FIXTURE_WALLETS.full}`);
  assert.equal(none.statusCode, 200);
  assert.deepEqual([none.body.tier, lite.body.tier, full.body.tier], ["none", "lite", "full"]);
  assert.deepEqual(
    [none.body.displayName, lite.body.displayName, full.body.displayName],
    [null, "cedar.07", "cedar.dot"]
  );
  for (const body of [none.body, lite.body, full.body]) {
    assert.equal(body.at.blockHash, PEOPLE_LITE_FIXTURE_AT.blockHash);
    assert.equal(body.at.blockNumber, PEOPLE_LITE_FIXTURE_AT.blockNumber);
    assert.equal(body.detail.gatesClaims, false);
  }
  assert.equal(none.headers["cache-control"], "no-store");
  assert.equal(lite.body.line.pill, "lite");
  assert.match(lite.body.line.tooltip, /attested Polkadot App install/u);
  assert.equal(full.body.detail.sdkTag, "Member");
});

test("a batch shares one pinned snapshot and rejects a missing wallet", async () => {
  const { get } = harness();
  const wallets = Object.values(PEOPLE_LITE_FIXTURE_WALLETS).join(",");
  const batch = await get(`/people/personhood?wallets=${wallets}`);
  assert.equal(batch.statusCode, 200);
  assert.equal(batch.body.results.length, 3);
  assert.equal(new Set(batch.body.results.map((read) => read.at.blockHash)).size, 1);
  await assert.rejects(() => get("/people/personhood?wallets="), /at least one/u);
  await assert.rejects(() => get("/people/personhood/not-a-wallet"), /20-byte/u);
});

test("a disabled reader does not answer with a fabricated none", async () => {
  const { get } = harness(createPeopleLiteReader({ source: "off", reason: "personhood_disabled" }));
  await assert.rejects(
    () => get(`/people/personhood/${PEOPLE_LITE_FIXTURE_WALLETS.lite}`),
    { code: "personhood_disabled", statusCode: 503 }
  );
});
