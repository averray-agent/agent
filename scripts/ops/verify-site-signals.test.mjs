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

const fixtureMergeDate = "2031-02-03";
const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
let output;
before(async () => {
  output = await mkdtemp(join(tmpdir(), "verify-site-signals-"));
  // Isolate output from the other ops tests that also build marketing/dist.
  await promisify(execFile)("npm", ["--workspace", "marketing", "run", "build", "--", "--outDir", output], {
    cwd: fileURLToPath(root), timeout: 120_000, maxBuffer: 2_000_000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", VERIFY_LEGAL_REVISION_DATE: fixtureMergeDate }
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
  for (const page of ["pricing", "terms", "privacy"]) {
    assert.ok(sitemap.includes(`<loc>https://averray.com/${page}/</loc>`), `sitemap: ${page}`);
    assert.ok(llms.includes(`https://averray.com/${page}/`), `llms: ${page}`);
    assert.ok(home.querySelector(`footer a[href="/${page}/"]`), `footer: ${page}`);
    assert.ok(sync.includes(`"${page}/index.html"`), `sync allow-list: ${page}`);
    assert.ok(deploy.includes(`"${page}/index.html /${page}/"`), `deployment allow-list: ${page}`);
  }
  assert.doesNotMatch(home.querySelector("footer").textContent + llms.split("## Terms")[1], /\b(?:draft|not approved|proposed|pending)\b/iu);
  assert.equal(home.querySelector('footer a[href="/terms/"]').textContent, "Terms");
  assert.ok(sync.includes('"llms.txt"'), "generated llms sync");
  assert.ok(deploy.includes('"llms.txt /llms.txt"'), "deployed llms byte check");
  for (const required of ["## Pricing", "https://api.averray.com/pricing", "https://api.averray.com/openapi.json",
    "https://raw.githubusercontent.com/averray-agent/agent/main/skills/averray-worker/SKILL.md",
    "https://raw.githubusercontent.com/averray-agent/agent/main/skills/averray-poster/SKILL.md"]) {
    assert.ok(llms.includes(required), required);
  }
});


test("legal pages: final public wording, truthful Verify boundaries and fixed operator commitments", async () => {
  const terms = new JSDOM(await built("terms/index.html")).window.document;
  const privacy = new JSDOM(await built("privacy/index.html")).window.document;
  const plain = (node) => node.textContent.replace(/\s+/gu, " ").trim();
  for (const [page, document] of [["terms", terms], ["privacy", privacy]]) {
    assert.equal(document.querySelector('link[rel="canonical"]').href, `https://averray.com/${page}/`);
    assert.doesNotMatch(document.documentElement.outerHTML, /\b(?:draft|not approved|proposed|pending)\b|\[Confirm:|\[date/iu);
    assert.ok(plain(document.querySelector("header")).includes(`Last updated ${fixtureMergeDate}.`));
  }
  for (const document of [terms, privacy]) {
    assert.ok(plain(document.body).includes("the paying wallet address and the payment transaction"));
    assert.doesNotMatch(plain(document.body), /Coinbase CDP/iu);
  }
  assert.equal(terms.querySelectorAll("[data-verify-terms] h2").length, 10);
  const termsText = plain(terms.querySelector("[data-verify-terms]"));
  for (const claim of [
    "Pascal Kuriger, sole proprietor", "Hauptstrasse 51, 8162 Steinmaur, Switzerland",
    "POST https://api.averray.com/verify/runs", "published profile, a target, and inputs",
    "approved, rejected or inconclusive", "platform_fault and are not charged", "with a signed receipt",
    "x402 in USDC on Base", "HTTP 402 quote for the profile you request",
    "only when the run returns approved or rejected", "fault on our side, are not charged",
    "expires unused, or that you cancel before capture, is not charged",
    "Payments are final on chain", "new transfer to the paying address",
    "email pkuriger@averray.com within 30 days", "Include the run id", "review the run, its receipt and its logs",
    "we refund the price of that run", "correctly applied profile is not a fault",
    "must have the right to submit", "Don't send secrets, private keys",
    "verification-target-authorization header, together with target.auth", "only for that run",
    "not written to the run record or the logs", "revoke it afterwards", "rate-limit or refuse requests",
    "Run records and receipts can be read by anyone with the run id", "without logging in",
    "target and inputs you submitted, the verdict, the billing status, the paying wallet address and the payment transaction", "published keys",
    "a warranty", "a security audit", "a certification", "legal advice", "provided as it is",
    "limited to the price you paid for that run", "indirect or consequential loss", "intent or gross negligence",
    "Art. 100 Swiss Code of Obligations", "402 quote at the time you sign always decides the price",
    "published here, with a new date", "Swiss law applies", "excluding the UN Convention",
    "courts of the city of Zurich", "mandatory consumer-protection rules"
  ]) assert.ok(termsText.includes(claim), claim);
  const privacyText = plain(privacy.querySelector("[data-verify-privacy]"));
  for (const claim of [
    "Base wallet address that signs", "signed x402 / EIP-3009 authorization (amount, nonce and validity window)",
    "resulting on-chain transaction", "On-chain transfers on Base are public and permanent",
    "profile you chose", "Your target", "your inputs", "verdict, the execution summary and the signed receipt",
    "Run records and receipts are publicly readable by run id", "Don't put personal data in them",
    "verification-target-authorization", "not stored in the run record or the logs", "memory for the run only",
    "Performance of the run you request and pay for", "legitimate interest",
    "Run records and receipts are kept indefinitely in our live database", "Payment records for 10 years",
    "Server logs follow the rotation described above", "at OVH in France (EU)", "mainnet.base.org",
    "Base (Coinbase)", "AWS KMS (eu-central-2)"
  ]) assert.ok(privacyText.includes(claim), claim);
  const privacyBody = plain(privacy.body);
  const termsBody = plain(terms.body);
  assert.match(privacyBody, /Sub-processors:.*Base \(Coinbase\) \(Base RPC for payment reads and transaction broadcast\)/u);
  assert.match(privacyBody, /Hosting is with OVH in Lille, France \(EU\)/u);
  assert.match(privacyBody, /Logs are size-capped per service and the oldest entries are deleted automatically when the cap is reached; they are used for security and abuse prevention, not profiling\./u);
  assert.doesNotMatch(privacyBody, /backup|short schedule|logs rotate/iu);
  assert.doesNotMatch(termsBody, /\bbackups?\b/iu);
  assert.doesNotMatch(privacyBody, /\blogs?\b[^.!?]*(?:\b(?:hours?|days?|weeks?|months?|years?)\b|\b(?:daily|weekly|monthly|annually|schedule)\b)/iu);
  assert.doesNotMatch(privacyBody, /OVH in the EU|OVH, EU data center/iu);
  for (const path of ["/imprint/", "/pricing/"]) assert.ok(terms.querySelector(`a[href="${path}"]`));
  assert.ok(privacy.querySelector('[data-verify-privacy] a[href="/terms/"]'));
});
