import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { PRIMARY_NAV_ITEMS, primaryNavLinks } from "../../marketing/src/navigation.mjs";
import {
  INTENTIONALLY_UNLINKED_ROUTES,
  checkMarketingReachability,
  marketingPageInventory
} from "./check-marketing-navigation.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);
const NAV = new URL("marketing/src/components/SiteNav.astro", REPO_ROOT);
const FOOTER = new URL("marketing/src/components/SiteFooter.astro", REPO_ROOT);

test("site navigation — every marketing page is reachable and an added unlinked page fails", async () => {
  const result = await checkMarketingReachability();
  const pages = await marketingPageInventory();

  assert.equal(result.routes.length, pages.length);
  assert.deepEqual(INTENTIONALLY_UNLINKED_ROUTES, []);

  const fixtureDirectory = await mkdtemp(join(tmpdir(), "averray-site-navigation-"));
  try {
    await writeFile(join(fixtureDirectory, "mutation-fixture.astro"), "<main>unlinked fixture</main>\n");
    const pagesRoot = pathToFileURL(`${fixtureDirectory}/`);
    await assert.rejects(
      checkMarketingReachability({ pagesRoot }),
      /Unlinked marketing page: \/mutation-fixture\//u
    );
  } finally {
    await rm(fixtureDirectory, { recursive: true });
  }
});

test("site navigation — Verify leads the primary navigation", () => {
  assert.deepEqual(PRIMARY_NAV_ITEMS[0], {
    key: "verify",
    label: "Verify",
    href: "/verify/"
  });
});

test("site navigation — the shared keyboard-reachable nav renders on every page including Pool", async () => {
  const [pages, nav, layout] = await Promise.all([
    marketingPageInventory(),
    readFile(NAV, "utf8"),
    readFile(new URL("marketing/src/layouts/PageLayout.astro", REPO_ROOT), "utf8")
  ]);

  assert.match(layout, /<SiteNav current=\{current\} \/>/u);
  for (const page of pages) {
    const source = await readFile(page.url, "utf8");
    assert.match(source, /<(?:SiteNav|PageLayout)\b/u, `${page.route} must render the shared navigation`);
    assert.match(source, /<(?:SiteFooter|PageLayout)\b/u, `${page.route} must render the shared footer`);
  }

  const pool = await readFile(new URL("marketing/src/pages/pool.astro", REPO_ROOT), "utf8");
  assert.match(pool, /<SiteNav current="pool" \/>/u);
  assert.match(nav, /<button[\s\S]*type="button"[\s\S]*aria-expanded="false"[\s\S]*aria-controls="nav-links"/u);
  assert.match(nav, /<summary>/u);
  assert.match(nav, /event\.key !== "Escape"/u);
  assert.match(nav, /\.focus\(\)/u);
});

test("site navigation — the current page is rendered without a self-link", async () => {
  const nav = await readFile(NAV, "utf8");
  const expectedCurrent = new Map([
    ["/", "home"],
    ...primaryNavLinks()
      .filter((link) => link.key !== null && !link.href.includes("#"))
      .map((link) => [link.href, link.key])
  ]);

  assert.match(nav, /current === "home" \? \([\s\S]*<span class="nav__brand nav__brand--current" aria-current="page">/u);
  assert.match(nav, /isCurrent\(link\.key\) \? \([\s\S]*<span class="nav__current" aria-current="page">/u);
  assert.match(nav, /isCurrent\(item\.key\) \? \([\s\S]*<span class="nav__current" aria-current="page">/u);

  const pages = await marketingPageInventory();
  for (const page of pages) {
    const key = expectedCurrent.get(page.route);
    if (!key) continue;
    const source = await readFile(page.url, "utf8");
    assert.ok(source.includes(`current="${key}"`), `${page.route} must identify itself as ${key}`);
  }
});

test("site navigation — footer and external destinations are unchanged", async () => {
  const [footer, nav] = await Promise.all([readFile(FOOTER, "utf8"), readFile(NAV, "utf8")]);
  const footerHrefs = [...footer.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]);

  assert.deepEqual(footerHrefs, [
    "https://polkadot.com",
    "https://github.com/averray-agent/agent/tree/main/docs",
    "/trust/",
    "/builders/",
    "/privacy/",
    "/imprint/",
    "https://x.com/Averray_Agents",
    "https://github.com/averray-agent/agent"
  ]);
  assert.match(nav, /href="https:\/\/app\.averray\.com"/u);
  assert.equal((nav.match(/https:\/\//gu) ?? []).length, 1);
});

test("site navigation — Pool remains in both marketing deployment allow-lists", async () => {
  const [sync, deploy] = await Promise.all([
    readFile(new URL("scripts/sync-marketing-site.mjs", REPO_ROOT), "utf8"),
    readFile(new URL("scripts/ops/deploy-production.sh", REPO_ROOT), "utf8")
  ]);

  assert.match(sync, /"pool\/index\.html"/u);
  assert.match(sync, /"pool-reader\.js"/u);
  assert.match(deploy, /"pool\/index\.html \/pool\/"/u);
  assert.match(deploy, /"pool-reader\.js \/pool-reader\.js"/u);
});
