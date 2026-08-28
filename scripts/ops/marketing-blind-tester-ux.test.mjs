import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const REPO_ROOT = new URL("../../", import.meta.url);

test("blind-tester marketing copy exposes copyable proof links and honest loading shells", async () => {
  const [home, receipts, verify, trust, footer, profile] = await Promise.all([
    readFile(new URL("marketing/src/pages/index.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/receipts.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/trust.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/components/SiteFooter.astro", REPO_ROOT), "utf8"),
    readFile(new URL("site/agent.html", REPO_ROOT), "utf8")
  ]);

  assert.match(home, /href="\/builders\/#install">connect over MCP<\/a>[\s\S]*there is no email signup\./u);
  assert.match(home, /Flat per-run pricing in USDC —[\s\S]*see the live price list\./u);
  assert.match(home, /api\.averray\.com\/schemas\/jobs/u);
  assert.match(home, /api\.averray\.com\/session\/state-machine/u);
  assert.doesNotMatch(home, /proof: "\/schemas\/jobs/u);

  for (const [name, source, endpoint] of [
    ["receipt", receipts, "api.averray.com/receipts/"],
    ["profile", profile, "api.averray.com/agents/"],
    ["verify", verify, "api.averray.com/verify/profiles"],
    ["trust", trust, "api.averray.com/status/providers"]
  ]) {
    assert.match(source, /<noscript>/u, `${name} shell must remain useful without JavaScript`);
    assert.ok(source.includes(endpoint), `${name} shell must expose its raw JSON endpoint`);
  }
  assert.ok(verify.includes("https://api.averray.com/.well-known/x402"));

  assert.match(footer, /title="GitHub">Docs \(GitHub\) ↗<\/a>/u);
  assert.match(footer, /rel="noopener"/u);
});

test("QA8 marketing exposes the canonical MCP install door and copy-safe snippets", async () => {
  const [home, builders, nav, copySnippet, css, llms] = await Promise.all([
    readFile(new URL("marketing/src/pages/index.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/builders.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/components/SiteNav.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/components/CopySnippet.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/styles/global.css", REPO_ROOT), "utf8"),
    readFile(new URL("site/llms.txt", REPO_ROOT), "utf8")
  ]);

  assert.match(builders, /<section class="section" id="install">/u);
  assert.match(nav, /label: "Install MCP", href: "\/builders\/#install"/u);
  assert.match(home, /href="\/builders\/#install">connect over MCP<\/a>/u);

  assert.equal((builders.match(/<CopySnippet /gu) ?? []).length, 3);
  assert.match(copySnippet, /data-copy-snippet-button/u);
  assert.match(copySnippet, /querySelector\("code"\)/u);
  assert.match(copySnippet, /navigator\.clipboard\.writeText\(value\)/u);
  assert.match(css, /\.install-snippet__scroll \{[\s\S]*overflow-x: auto;/u);
  assert.match(css, /\.install-card \{ min-width: 0; display: flex; flex-direction: column;[^}]*\}/u);
  assert.ok(builders.includes("https://api.averray.com/mcp"), "the full canonical URL must remain in copyable source values");

  assert.match(llms, /Canonical MCP endpoint: https:\/\/api\.averray\.com\/mcp/u);
  assert.match(llms, /https:\/\/averray\.com\/builders\/#install/u);
  assert.match(llms, /MCP protocol endpoint lives on the API host only/u);
  assert.match(llms, /Discovery manifest: https:\/\/averray\.com\/\.well-known\/agent-tools\.json/u);
});

test("QA3-A marketing wayfinding names real doors, live reads, and outbound proof surfaces", async () => {
  const [home, agents, builders, schemas, verify, verifyReader, proofToPay, transparency, trust, footer, consoleStream] =
    await Promise.all([
      readFile(new URL("marketing/src/pages/index.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/agents.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/builders.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/schemas.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/public/verify-reader.js", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/proof-to-pay.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/transparency.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/pages/trust.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/src/components/SiteFooter.astro", REPO_ROOT), "utf8"),
      readFile(new URL("marketing/public/console-stream.js", REPO_ROOT), "utf8")
    ]);

  const pages = [home, agents, builders, schemas, verify, proofToPay, transparency, trust];
  const allMarketingCopy = [...pages, footer].join("\n");
  const publishedWallet = "0x3071Ca2Adc1FB6F6986cDb6D7117C4c4fec455ee";

  assert.doesNotMatch(allMarketingCopy, /0x10E82610BDFb7A4fC0d5E1c2E0694C810434214b/u);
  assert.doesNotMatch(consoleStream, /0x10E826…214b/u);
  assert.match(consoleStream, /0x3071Ca…55ee/u);
  for (const [name, source] of [["home", home], ["agents", agents], ["builders", builders], ["schemas", schemas], ["trust", trust]]) {
    assert.ok(source.includes(publishedWallet), `${name} must use the published case-study wallet`);
  }

  assert.doesNotMatch(pages.join("\n"), /\/strategies\b/u);
  assert.match(agents, /GET \/verify\/profiles/u);
  assert.match(builders, /\/verify\/profiles/u);
  assert.doesNotMatch(allMarketingCopy, /JSON:[^\s<]/u);
  assert.doesNotMatch(allMarketingCopy, /\bcertification\b/iu);

  assert.match(home, /browse without a wallet/u);
  assert.match(home, /wallet sign-in \(SIWE\)/u);
  assert.match(home, /href: "\/proof-to-pay\/"/u);
  assert.match(home, /posting settles on proof/iu);
  assert.doesNotMatch(home, /marketplace/iu);

  for (const [name, source] of [["proof-to-pay", proofToPay]]) {
    assert.match(source, /HTTP\/MCP with payment authorization/u, `${name} must name the machine door`);
    assert.match(source, /wallet sign-in/u, `${name} must name the operator door`);
    assert.match(source, /\/work/u, `${name} must name the human door`);
    assert.match(source, /\/builders\/#glossary/u, `${name} must link the glossary`);
  }

  assert.ok(verify.includes("https://api.averray.com/.well-known/x402"), "Verify must expose live payment discovery");
  assert.ok(verify.includes("https://api.averray.com/verify/profiles"), "Verify must expose profiles and worked examples");
  assert.match(verify, /Verify is the paid door; worker tools stay free\./u);
  assert.match(verifyReader, /payload\.resources\[0\]/u, "Verify pricing must parse the first live resource");
  assert.match(verifyReader, /resource\.accepts\[0\]/u, "Verify pricing must parse its first accepted requirement");

    for (const term of ["SIWE / EIP-4361", "EIP-3009", "x402", "Waiver-eligible", "Co-signer / multisig"]) {
    assert.ok(builders.includes(term), `builders glossary must define ${term}`);
  }
  assert.match(builders, /Claim tier \/ Reputation tier/u);
  assert.match(builders, /starter \/ pro \/ elite claim tier/u);
  assert.match(builders, /apprentice \/ journeyman \/ expert \/ master reputation tier/u);
  assert.match(proofToPay, /https:\/\/app\.averray\.com\/poster\//u);

  assert.match(builders, /id="install"/u);
  assert.match(builders, /Add to Cursor/u);
  assert.match(builders, /claude mcp add --transport http averray https:\/\/api\.averray\.com\/mcp/u);
  assert.match(builders, /"command": "npx"/u);
  assert.match(builders, /"args": \["-y", "@averray\/mcp"\]/u);

  const deeplink = builders.match(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=averray&amp;config=([^"<]+)/u)
    ?? builders.match(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=averray&config=([^"<]+)/u);
  assert.ok(deeplink, "builders must carry the Cursor MCP install deeplink");
  const encodedConfig = decodeURIComponent(deeplink[1]);
  assert.deepEqual(JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8")), {
    url: "https://api.averray.com/mcp"
  });

  assert.match(agents, /Starter jobs are deliberately small; rewards and caps rise with settled history\./u);
  assert.match(transparency, /deliberately small pilot treasury/u);
  assert.match(transparency, /every figure is the live ledger, unedited/iu);
  assert.match(transparency, /realized write-off \(venue loss\)/iu);

  for (const label of [
    "case study (GitHub)",
    "Multisig setup (GitHub)",
    "Audit package (GitHub)",
    "README (GitHub)",
    "Agent banking vision (GitHub)",
    "Docs (GitHub)"
  ]) {
    assert.ok(allMarketingCopy.includes(label), `GitHub exit must be labeled: ${label}`);
  }
});

test("Caddy returns explicit 301 redirects for guessed public paths", async () => {
  const caddy = await readFile(new URL("deploy/Caddyfile.averray", REPO_ROOT), "utf8");
  const redirects = [
    ["@docsPath", "https://github.com/averray-agent/agent/tree/main/docs"],
    ["@fulfillPath", "/agents/"],
    ["@recordPath", "/transparency/"],
    ["@jobsSchemaPath", "https://api.averray.com/schemas/jobs"],
    ["@sessionStateMachinePath", "https://api.averray.com/session/state-machine"],
    ["@onboardingPath", "https://api.averray.com/onboarding"],
    ["@healthPath", "https://api.averray.com/health"],
    ["@jobTiersPath", "https://api.averray.com/jobs/tiers"],
    ["@verifyProfilesPath", "https://api.averray.com/verify/profiles"],
    ["@posterDoorPath", "https://app.averray.com/poster/"],
    ["@getStartedPath", "https://averray.com/agents/"],
    ["@posterAliasPath", "/poster/"],
    ["@posterJobsAliasPath", "/poster/"],
    ["@verifyAliasPath", "/runs/"]
  ];
  for (const [matcher, target] of redirects) {
    assert.ok(caddy.includes(`redir ${matcher} ${target} 301`), `${matcher} must be a 301 to ${target}`);
  }
});

test("Caddy sends public records and work paths to their canonical domains", async () => {
  const caddy = await readFile(new URL("deploy/Caddyfile.averray", REPO_ROOT), "utf8");

  assert.match(caddy, /@operatorWorkPath path \/work \/work\/\*[\s\S]*redir @operatorWorkPath https:\/\/app\.averray\.com\/work 301/u);
  assert.match(caddy, /@posterDoorPath path \/post \/post\/ \/poster \/poster\/[\s\S]*redir @posterDoorPath https:\/\/app\.averray\.com\/poster\/ 301/u);
  assert.match(caddy, /@publicTransparencyPath path \/transparency \/transparency\/[\s\S]*redir @publicTransparencyPath https:\/\/averray\.com\/transparency\/ 301/u);
  assert.match(caddy, /@publicReceiptSubpath path_regexp \^\/receipts\/0x\[0-9a-fA-F\]\{6,\}\/\?\$[\s\S]*redir @publicReceiptSubpath https:\/\/averray\.com\{uri\} 301/u);
  assert.match(caddy, /@legacyJobsPath path \/jobs \/jobs\/\*[\s\S]*redir @legacyJobsPath https:\/\/app\.averray\.com\/work 301/u);
  assert.match(caddy, /@legacyWorkWithdrawal path \/work\/withdraw \/work\/withdraw\/ \/withdraw \/withdraw\/ \/earnings \/earnings\/[\s\S]*redir @legacyWorkWithdrawal \/work-withdraw\/ 301/u);
  assert.doesNotMatch(caddy, /@publicReceiptSubpath path \/receipts(?:\s|$)/u, "bare /receipts must stay in the operator app");
});

test("Caddy sends guessed MCP install aliases to the canonical builders install section", async () => {
  const caddy = await readFile(new URL("deploy/Caddyfile.averray", REPO_ROOT), "utf8");

  assert.match(
    caddy,
    /www\.averray\.com \{[\s\S]*@installAliases path \/mcp \/mcp\/ \/install \/install\/ \/cursor \/cursor\/ \/claude \/claude\/[\s\S]*redir @installAliases https:\/\/averray\.com\/builders\/#install 301/u
  );
  assert.match(
    caddy,
    /app\.averray\.com \{[\s\S]*@installAliases path \/mcp \/mcp\/ \/install \/install\/ \/connect \/connect\/[\s\S]*redir @installAliases https:\/\/averray\.com\/builders\/#install 301/u
  );
});

test("marketing clips the sticky nav 100vw band without creating a horizontal scroll container", async () => {
  const css = await readFile(new URL("marketing/src/styles/global.css", REPO_ROOT), "utf8");

  assert.match(css, /html \{[\s\S]*overflow-x: clip;[\s\S]*\}/u);
  assert.match(css, /\.nav::before \{[\s\S]*width: 100vw;[\s\S]*\}/u);
  assert.match(css, /sticky nav's full-viewport backdrop band uses 100vw/u);
});

test("Caddy revalidates HTML, preserves versioned-asset caching, and rewrites every receipt path", async () => {
  const caddy = await readFile(new URL("deploy/Caddyfile.averray", REPO_ROOT), "utf8");

  assert.match(caddy, /@versionedAssets \{[\s\S]*path \*\.css \*\.js[\s\S]*query v=\*[\s\S]*\}/u);
  assert.match(caddy, /header @versionedAssets Cache-Control "public, max-age=31536000, immutable"/u);
  assert.match(caddy, /Cache-Control "no-cache"[\s\S]*match header Content-Type text\/html\*/u);
  assert.match(caddy, /@workReceipt path \/receipts\/\*[\s\S]*rewrite @workReceipt \/receipts\/index\.html/u);
});

test("receipt shell distinguishes a missing id from an unknown id and keeps recovery links", async () => {
  const [reader, shell] = await Promise.all([
    readFile(new URL("marketing/public/receipt-reader.js", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/receipts.astro", REPO_ROOT), "utf8")
  ]);

  function evaluate(pathname) {
    const elements = {
      "[data-receipt-state]": { dataset: {} },
      "[data-receipt-status]": { textContent: "" },
      "[data-receipt]": { hidden: true },
      "[data-receipt-guidance]": { hidden: true }
    };
    runInNewContext(reader, {
      document: {
        querySelector(selector) { return elements[selector] ?? null; },
        querySelectorAll() { return []; }
      },
      window: {
        location: { pathname },
        AverrayReaderFetch: {
          readJsonWithRetry: async () => {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
        }
      }
    });
    return elements;
  }

  const missing = evaluate("/receipts/");
  assert.equal(missing["[data-receipt-status]"].textContent, "no receipt id in the URL");
  assert.equal(missing["[data-receipt-guidance]"].hidden, false);

  const unknown = evaluate("/receipts/abc");
  assert.equal(unknown["[data-receipt-status]"].textContent, "no receipt found for this id");
  assert.equal(unknown["[data-receipt-guidance]"].hidden, false);

  const unknownHash = evaluate(`/receipts/0x${"0".repeat(64)}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unknownHash["[data-receipt-status]"].textContent, "no receipt found for this id");
  assert.equal(unknownHash["[data-receipt-guidance]"].hidden, false);

  assert.doesNotMatch(shell, /data-receipt-guidance-message/u);
  assert.match(shell, /id="receipt" class="record-anchor"/u);
  assert.match(shell, /id="outcome" class="record-anchor"/u);
  assert.match(shell, /0xe302d62bef7f96686bba5db4cfc44fc5743b5464706f2acbc0e6350929a62ce1/u);
  assert.match(shell, /0x8a99c2e19b75a7e3b19e1aefb4448be162e89480d953c20ad813b8dda12797c0/u);
  assert.match(shell, /href="\/transparency\/"/u);
});

test("marketing and the public orientation mirror do not advertise retired strategies", async () => {
  const sources = await Promise.all([
    readFile(new URL("marketing/src/pages/agents.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/src/pages/builders.astro", REPO_ROOT), "utf8"),
    readFile(new URL("site/llms.txt", REPO_ROOT), "utf8")
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, /api\.averray\.com\/strategies|GET \/strategies|label: "\/strategies"/u);
  }
});
