import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { VerificationProfileRegistry } from "../../mcp-server/src/services/verification-profile-registry.js";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
let output;
before(async () => {
  output = await mkdtemp(join(tmpdir(), "verify-site-signals-"));
  // Isolate output from the other ops tests that also build marketing/dist.
  await promisify(execFile)("npm", ["--workspace", "marketing", "run", "build", "--", "--outDir", output], {
    cwd: fileURLToPath(root), timeout: 120_000, maxBuffer: 2_000_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" }
  });
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });
const built = (path) => readFile(join(output, path), "utf8");

function assertPrices(html) {
  const document = new JSDOM(html).window.document;
  const rows = [...document.querySelectorAll("[data-verify-price-table] tbody tr")];
  assert.deepEqual(rows.map((row) => ({
    profile: row.dataset.profile,
    billingRule: row.dataset.billingRule,
    cells: [...row.cells].map((cell) => cell.textContent.trim())
  })), new VerificationProfileRegistry().list().map((p) => ({
    profile: p.ref, billingRule: p.price.billingRule,
    cells: [p.ref, `${p.price.amount} ${p.price.asset}`, p.price.network]
  })));
  assert.equal(document.querySelector("[data-verify-billing-rule]").textContent.trim(),
    "No verdict, no charge. Inconclusive runs are not billed.");
  assert.match(document.body.textContent, /A rejected result is a completed check and is billed/u);
  assert.match(document.body.textContent, /live 402 quote for your requested profile/u);
  assert.equal(document.querySelector('link[rel="canonical"]').href, "https://averray.com/pricing/");
}

test("site signals: built pricing equals registry, including visible numbers and billing rule", async () => {
  const html = await built("pricing/index.html");
  assertPrices(html);
  // Prove the checker reads visible cells, not just a matching hidden attribute.
  const document = new JSDOM(html).window.document;
  document.querySelector("[data-verify-price-table] tbody td").textContent = "999 USDC";
  assert.throws(() => assertPrices(document.documentElement.outerHTML), assert.AssertionError);
  for (const path of ["marketing/src/pages/pricing.astro", "mcp-server/src/core/verify-pricing.js"]) {
    assert.doesNotMatch(await read(path), /\b\d+(?:\.\d+)?\s*USDC\b|\b(?:5000000|250000)\b/iu, path);
  }
});

test("site signals: sitemap, llms, navigation and both deployment allow-lists include new pages", async () => {
  const [sitemap, llms, sync, deploy] = await Promise.all([
    built("sitemap.xml"), built("llms.txt"), read("scripts/sync-marketing-site.mjs"), read("scripts/ops/deploy-production.sh")
  ]);
  const home = new JSDOM(await built("index.html")).window.document;
  for (const page of ["pricing"]) {
    assert.ok(sitemap.includes(`<loc>https://averray.com/${page}/</loc>`), `sitemap: ${page}`);
    assert.ok(llms.includes(`https://averray.com/${page}/`), `llms: ${page}`);
    assert.ok(home.querySelector(`footer a[href="/${page}/"]`), `footer: ${page}`);
    assert.ok(sync.includes(`"${page}/index.html"`), `sync allow-list: ${page}`);
    assert.ok(deploy.includes(`"${page}/index.html /${page}/"`), `deployment allow-list: ${page}`);
  }
  assert.doesNotMatch(sitemap + llms + home.body.textContent, /\/terms\/|## Terms|DRAFT — pending operator approval|not approved/iu);
  assert.ok(sync.includes('"llms.txt"'), "generated llms sync");
  assert.ok(deploy.includes('"llms.txt /llms.txt"'), "deployed llms byte check");
  for (const required of ["## Pricing", "https://api.averray.com/pricing", "https://api.averray.com/openapi.json",
    "https://raw.githubusercontent.com/averray-agent/agent/main/skills/averray-worker/SKILL.md",
    "https://raw.githubusercontent.com/averray-agent/agent/main/skills/averray-poster/SKILL.md"]) {
    assert.ok(llms.includes(required), required);
  }
});
