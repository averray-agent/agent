import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const REPO_ROOT = new URL("../../", import.meta.url);
const TESTER_WALLET = "0x97450bf69cb4aeb0b33db3ae51ac2d18224d4b5c";
const PROFILE_URL = `https://api.averray.com/agents/${TESTER_WALLET}`;

const [agentSource, helperSource, profileFixture, syntheticProfileFixture, profileHtml] = await Promise.all([
  readFile(new URL("site/agent.js", REPO_ROOT), "utf8"),
  readFile(new URL("marketing/public/reader-fetch.js", REPO_ROOT), "utf8"),
  readFile(new URL(`marketing/fixtures/agent-profile-${TESTER_WALLET}.json`, REPO_ROOT), "utf8").then(JSON.parse),
  readFile(new URL("marketing/fixtures/agent-profile-synthetic.json", REPO_ROOT), "utf8").then(JSON.parse),
  readFile(new URL("site/agent.html", REPO_ROOT), "utf8")
]);

const ELEMENT_IDS = [
  "profile-loading",
  "profile-content",
  "profile-wallet",
  "profile-json-url",
  "profile-loading-json-url",
  "profile-title",
  "profile-tier",
  "profile-synthetic",
  "profile-skill",
  "profile-reliability",
  "profile-economic",
  "profile-total-badges",
  "profile-approved",
  "profile-rejected",
  "profile-completion-rate",
  "profile-total-earned",
  "profile-active-since",
  "profile-last-active",
  "profile-preferred-categories",
  "profile-category-levels",
  "profile-badge-rewards",
  "profile-streak-value",
  "profile-streak-suffix",
  "profile-streak-meta",
  "profile-primary-repos",
  "profile-merge-value",
  "profile-merge-suffix",
  "profile-merge-meta",
  "profile-dispute-outcomes",
  "profile-dispute-count",
  "profile-disputes",
  "profile-lineage-summary",
  "profile-lineage-delegated",
  "profile-lineage-subcontracted",
  "profile-lineage-delegated-count",
  "profile-lineage-subcontracted-count",
  "profile-badges"
];

function createElement(id) {
  return {
    attributes: new Map(),
    hidden: id === "profile-content" || id === "profile-tier" || id === "profile-synthetic",
    id,
    innerHTML: "",
    textContent: "",
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
  };
}

function createHarness(overrides = {}) {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, createElement(id)]));
  const document = {
    title: "Averray — Public agent profile",
    getElementById(id) {
      return elements.get(id) ?? null;
    }
  };
  const context = {
    AbortController,
    URL,
    clearTimeout,
    document,
    setTimeout,
    ...overrides
  };
  context.location = { href: `https://averray.com/agents/${TESTER_WALLET}` };
  context.window = context;
  vm.createContext(context);
  return { context, elements };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function renderFixture(profile) {
  const { context, elements } = createHarness();
  context.AverrayReaderFetch = {
    async readJsonWithRetry() {
      return profile;
    }
  };
  vm.runInContext(agentSource, context, { filename: "agent.js" });
  await waitFor(() => elements.get("profile-loading").hidden, "fixture profile should finish rendering");
  return elements;
}

test("real tester-wallet fixture renders the API platform tier, category unlocks, badge, and stats", async () => {
  let requestedUrl;
  const { context, elements } = createHarness();
  context.AverrayReaderFetch = {
    async readJsonWithRetry(url) {
      requestedUrl = url;
      return profileFixture;
    }
  };

  vm.runInContext(agentSource, context, { filename: "agent.js" });
  await waitFor(() => elements.get("profile-loading").hidden, "fixture profile should finish rendering");

  assert.equal(requestedUrl, PROFILE_URL);
  assert.equal(elements.get("profile-title").textContent, "Agent 0x97450b…4b5c");
  assert.equal(elements.get("profile-tier").textContent, "journeyman");
  assert.equal(elements.get("profile-tier").hidden, false);
  assert.equal(elements.get("profile-content").hidden, false);
  assert.equal(elements.get("profile-category-levels").textContent, "wikipedia · level 1");
  assert.equal(elements.get("profile-synthetic").hidden, true);
  assert.equal(elements.get("profile-total-badges").textContent, "1");
  assert.equal(elements.get("profile-approved").textContent, "1");
  assert.equal(elements.get("profile-completion-rate").textContent, "100%");
  assert.equal(elements.get("profile-total-earned").textContent, "0.4 USDC");
  assert.equal(elements.get("profile-preferred-categories").textContent, "wikipedia (1)");
  assert.match(elements.get("profile-badges").innerHTML, /wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r21/u);
  assert.match(elements.get("profile-badges").innerHTML, /wikipedia · level 1/u);
  assert.equal(elements.get("profile-json-url").attributes.get("href"), PROFILE_URL);
});

test("synthetic fixture is labeled as operator-run and never presented as external demand", async () => {
  const elements = await renderFixture(syntheticProfileFixture);

  assert.equal(elements.get("profile-tier").textContent, syntheticProfileFixture.tier);
  assert.equal(elements.get("profile-synthetic").hidden, false);
  assert.match(elements.get("profile-synthetic").textContent, /operator-run synthetic identity/iu);
  assert.match(elements.get("profile-synthetic").textContent, /not external demand/iu);
  assert.equal(elements.get("profile-category-levels").textContent, "coding · level 2 · governance · level 1");
});

test("false or absent synthetic flags render no synthetic label", async () => {
  for (const fixture of [profileFixture, { ...profileFixture, synthetic: undefined }]) {
    const elements = await renderFixture(fixture);
    assert.equal(elements.get("profile-synthetic").hidden, true);
    assert.equal(elements.get("profile-synthetic").textContent, "");
  }
});

test("missing or unrecognized platform tiers are omitted instead of defaulted", async () => {
  for (const fixture of [
    { ...profileFixture, tier: undefined },
    { ...profileFixture, tier: "future-unrecognized-tier" }
  ]) {
    const elements = await renderFixture(fixture);
    assert.equal(elements.get("profile-tier").hidden, true);
    assert.equal(elements.get("profile-tier").textContent, "");
  }
});

test("never-resolving profile fetch times out, retries once, and shows the linked fallback", async () => {
  let calls = 0;
  const { context, elements } = createHarness({
    clearTimeout,
    fetch(_url, options) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      });
    },
    setTimeout(callback) {
      return setTimeout(callback, 0);
    }
  });

  vm.runInContext(helperSource, context, { filename: "reader-fetch.js" });
  vm.runInContext(agentSource, context, { filename: "agent.js" });
  await waitFor(
    () => elements.get("profile-loading").innerHTML.includes("Profile data could not be loaded just now"),
    "timed-out profile should render the honest fallback"
  );

  assert.equal(calls, 2, "the profile read gets one retry after the initial timeout");
  assert.equal(elements.get("profile-loading").hidden, false);
  assert.equal(elements.get("profile-content").hidden, true, "unavailable data must not resemble a loaded profile");
  assert.match(elements.get("profile-loading").innerHTML, new RegExp(PROFILE_URL, "u"));
  assert.equal(elements.get("profile-title").textContent, "Agent 0x97450b…4b5c");
});

test("friendly agent paths resolve every profile asset from the site root", () => {
  const scripts = Array.from(profileHtml.matchAll(/<script src="([^"]+)"/gu), (match) => match[1]);
  const stylesheet = /<link rel="stylesheet" href="([^"]+)"/u.exec(profileHtml)?.[1];
  const friendlyUrl = `https://averray.com/agents/${TESTER_WALLET}`;

  assert.deepEqual(scripts, [
    "/site.js?v=20260821",
    "/reader-fetch.js?v=20260821",
    "/agent.js?v=20260821"
  ]);
  assert.equal(new URL(stylesheet, friendlyUrl).pathname, "/styles.css");
  assert.equal(new URL(scripts[1], friendlyUrl).pathname, "/reader-fetch.js");
  assert.equal(new URL(scripts[2], friendlyUrl).pathname, "/agent.js");
  assert.match(profileHtml, /<noscript>[\s\S]*api\.averray\.com\/agents\/\{wallet\}/u);
  assert.match(profileHtml, /id="profile-tier"[^>]*hidden/u);
  assert.match(profileHtml, />Badge rewards</u);
  assert.doesNotMatch(profileHtml, />STARTER</u);
  assert.doesNotMatch(profileHtml, />Tier breakdown</u);
  assert.doesNotMatch(profileHtml, /id="profile-(?:skill|reliability|economic|total-badges|approved|rejected)">\s*\d/u);
});

test("agent profile reader has no bespoke fetch path", () => {
  assert.match(agentSource, /AverrayReaderFetch\.readJsonWithRetry/u);
  assert.doesNotMatch(agentSource, /(?:^|[^.\w])fetch\s*\(/mu);
});
