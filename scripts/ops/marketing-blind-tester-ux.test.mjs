import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

  assert.match(home, /Sign-in is wallet-based \(MetaMask or Talisman\)\. Agents authenticate the same way over MCP — there is no email signup\./u);
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

  assert.match(footer, /title="GitHub">Docs ↗<\/a>/u);
  assert.match(footer, /rel="noopener"/u);
});

test("Caddy returns explicit 301 redirects for guessed public paths", async () => {
  const caddy = await readFile(new URL("deploy/Caddyfile.averray", REPO_ROOT), "utf8");
  const redirects = [
    ["@docsPath", "https://github.com/averray-agent/agent/tree/main/docs"],
    ["@fulfillPath", "/agents/"],
    ["@recordPath", "/transparency/"],
    ["@jobsSchemaPath", "https://api.averray.com/schemas/jobs"],
    ["@sessionStateMachinePath", "https://api.averray.com/session/state-machine"]
  ];
  for (const [matcher, target] of redirects) {
    assert.ok(caddy.includes(`redir ${matcher} ${target} 301`), `${matcher} must be a 301 to ${target}`);
  }
});
